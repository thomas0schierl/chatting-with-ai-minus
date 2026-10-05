import { anthropicThinking, cachedCatalog, catalogIdentity } from "./model-catalog";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ContentBlock,
  ImageAttachment,
  StreamOptions,
} from "../types";
import { streamSSE } from "./stream";
import { withoutOldToolImages } from "../agent/history";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

/**
 * Sends a message to the Anthropic Messages API. The answer is streamed
 * (ADR-12) and rebuilt into the same message the non-streamed API returns.
 *
 * Anthropic format:
 * - System prompt is a top-level field, not a message
 * - Tools use `input_schema` (not `parameters`)
 * - Tool results are sent as user messages with type "tool_result"
 */
export async function sendAnthropicMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string,
  stream: StreamOptions = {},
): Promise<UnifiedResponse> {
  const model = settings.model || "claude-sonnet-4-6";
  const identity = await catalogIdentity("anthropic", settings.apiKey);
  if (settings.modelCatalog) {
    cachedCatalog(settings.modelCatalog, "anthropic", identity);
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: 16384,
    stream: true,
    // System prompt as a content block with cache_control breakpoint.
    // Anthropic caches everything up to the breakpoint across requests.
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: withoutOldToolImages(messages).map(msg => toAnthropicMessage(msg, model, identity)),
  };

  // Thinking mode and effort come from the model catalog (`/v1/models`
  // capabilities). Models without catalog data run on their defaults.
  Object.assign(body, anthropicThinking(model, settings.thinkingLevel));

  if (tools.length > 0 || settings.enableWebSearch) {
    const apiTools: Record<string, unknown>[] = tools.map((t, i, arr) => {
      const tool: Record<string, unknown> = {
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      };
      // Place cache_control breakpoint on the last function tool
      // so the entire tools array prefix is cached
      if (i === arr.length - 1 && !settings.enableWebSearch) {
        tool.cache_control = { type: "ephemeral" };
      }
      return tool;
    });

    // Anthropic web search is a server-managed tool
    if (settings.enableWebSearch) {
      apiTools.push({
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
        cache_control: { type: "ephemeral" },
      });
    }

    body.tools = apiTools;
  }

  const collected = collectAnthropicStream(stream.onTextDelta);
  let response;
  try {
    response = await streamSSE(ANTHROPIC_API_URL, {
      headers: {
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        accept: "text/event-stream",
        // Required for the CORS answer to `fetch` from Obsidian's origins.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    }, collected.onEvent, stream.signal);
  } catch (e: unknown) {
    // requestUrl throws on network errors; extract API details if available
    const err = asRecord(e);
    const status = typeof err.status === "number" ? err.status : "unknown";
    const apiMsg = getNestedString(err, ["json", "error", "message"]);
    if (apiMsg) {
      throw new Error(`Anthropic API error (${status}): ${apiMsg}`);
    }
    throw e;
  }

  if (response.status !== 200) {
    const errorText = getNestedString(response.json, ["error", "message"]) ?? `HTTP ${response.status}`;
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  const data = parseAnthropicResponse(collected.finish());
  const sources = citedSources(data.content);

  return {
    content: [
      ...data.content.map(fromAnthropicBlock).filter((b): b is ContentBlock => b !== null),
      ...(sources ? [sources] : []),
    ],
    // Thinking signatures, redacted thinking, citations and server tool results
    // must be returned unchanged. UI content is deliberately separate.
    replay: { provider: "anthropic", model, identity, items: data.content },
    stopReason: normalizeStopReason(data.stop_reason),
    usage: data.usage
      ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
      : undefined,
  };
}

// ─── Streaming ──────────────────────────────────────────────────────────────

/**
 * Rebuilds the message from Messages API stream events, block by block:
 * text, thinking and signatures are concatenated from their deltas, tool
 * inputs parsed from their JSON deltas, citations collected; other blocks
 * (redacted thinking, server tool results) arrive whole in
 * `content_block_start`. Text deltas also go to `onTextDelta`.
 */
function collectAnthropicStream(onTextDelta?: (text: string) => void): {
  onEvent: (event: Record<string, unknown>) => void;
  finish: () => Record<string, unknown>;
} {
  let message: Record<string, unknown> | undefined;
  const blocks: Record<string, unknown>[] = [];
  const inputJson = new Map<number, string>();
  let stopped = false;
  let failure: string | undefined;
  return {
    onEvent: (event) => {
      const index = typeof event.index === "number" ? event.index : -1;
      const delta = asRecord(event.delta);
      switch (event.type) {
        case "message_start":
          message = { ...asRecord(event.message) };
          break;
        case "content_block_start":
          if (index >= 0 && isRecord(event.content_block)) blocks[index] = { ...event.content_block };
          break;
        case "content_block_delta": {
          const block = blocks[index];
          if (!block) break;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            block.text = (typeof block.text === "string" ? block.text : "") + delta.text;
            if (delta.text) onTextDelta?.(delta.text);
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            block.thinking = (typeof block.thinking === "string" ? block.thinking : "") + delta.thinking;
          } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
            block.signature = (typeof block.signature === "string" ? block.signature : "") + delta.signature;
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            inputJson.set(index, (inputJson.get(index) ?? "") + delta.partial_json);
          } else if (delta.type === "citations_delta" && delta.citation !== undefined) {
            block.citations = [...(Array.isArray(block.citations) ? block.citations as unknown[] : []), delta.citation];
          }
          break;
        }
        case "content_block_stop": {
          const json = inputJson.get(index);
          const block = blocks[index];
          if (block && json) {
            try {
              const input: unknown = JSON.parse(json);
              if (isRecord(input)) block.input = input;
            } catch {
              // Truncated input (max_tokens): the loop won't run this call.
            }
          }
          // A server_tool_use may start without `input`; replay needs one.
          if (block && (block.type === "tool_use" || block.type === "server_tool_use") && !isRecord(block.input)) block.input = {};
          break;
        }
        case "message_delta":
          if (message) {
            Object.assign(message, delta);
            if (isRecord(event.usage)) message.usage = { ...asRecord(message.usage), ...event.usage };
          }
          break;
        case "message_stop":
          stopped = true;
          break;
        case "error": {
          const error = asRecord(event.error);
          const type = typeof error.type === "string" ? error.type : "error";
          failure = `Anthropic API error (${type}): ${typeof error.message === "string" ? error.message : "stream failed"}`;
          break;
        }
      }
    },
    finish: () => {
      if (failure) throw new Error(failure);
      if (!message || !stopped) throw new Error("Anthropic stream ended before the message was complete.");
      return { ...message, content: blocks.filter(Boolean) };
    },
  };
}

// ─── Format Conversions ─────────────────────────────────────────────────────

interface AnthropicContentBlock extends Record<string, unknown> {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  citations?: unknown;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

function parseAnthropicResponse(value: unknown): AnthropicResponse {
  if (!isRecord(value)) return { content: [] };
  const content = Array.isArray(value.content)
    ? value.content.filter(isAnthropicContentBlock)
    : [];
  const usage = isRecord(value.usage)
    ? {
        input_tokens: typeof value.usage.input_tokens === "number" ? value.usage.input_tokens : 0,
        output_tokens: typeof value.usage.output_tokens === "number" ? value.usage.output_tokens : 0,
      }
    : undefined;
  return {
    content,
    stop_reason: typeof value.stop_reason === "string" ? value.stop_reason : undefined,
    usage,
  };
}

function isAnthropicContentBlock(value: unknown): value is AnthropicContentBlock {
  return isRecord(value) && typeof value.type === "string";
}

function normalizeStopReason(value: string | undefined): UnifiedResponse["stopReason"] {
  if (value === "tool_use" || value === "max_tokens" || value === "stop" || value === "pause_turn") return value;
  return "end_turn";
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toAnthropicMessage(msg: UnifiedMessage, model: string, identity: string): Record<string, unknown> {
  if (msg.role === "assistant" && msg.replay?.provider === "anthropic" && (!msg.replay.model || msg.replay.model === model) && (!msg.replay.identity || msg.replay.identity === identity)) {
    return { role: msg.role, content: msg.replay.items };
  }
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }

  // Content blocks (tool_use responses from assistant, tool_result from user)
  const blocks = msg.content.map((block) => {
    if (block.type === "tool_result") {
      // Images from view_image/view_canvas go inside the tool_result.
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.images?.length
          ? [{ type: "text", text: block.content || "(image)" }, ...block.images.map(anthropicImage)]
          : block.content,
        is_error: block.is_error || false,
      };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    if (block.type === "image" && block.image) {
      return anthropicImage(block.image);
    }
    return { type: "text", text: block.text };
  }).filter((b) => !(b.type === "text" && !b.text));

  return { role: msg.role, content: blocks };
}

function anthropicImage(image: ImageAttachment): Record<string, unknown> {
  return {
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data: image.data },
  };
}

/**
 * The web pages a web search answer cites (`web_search_result_location`
 * citations on its text blocks), each once, as a list after the answer:
 * Anthropic asks apps to show the sources with the answer.
 */
function citedSources(blocks: AnthropicContentBlock[]): ContentBlock | null {
  const sources = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations as unknown[]) {
      if (!isRecord(citation) || citation.type !== "web_search_result_location" || typeof citation.url !== "string") continue;
      if (!sources.has(citation.url)) sources.set(citation.url, typeof citation.title === "string" && citation.title ? citation.title : citation.url);
    }
  }
  if (sources.size === 0) return null;
  const links = [...sources].map(([url, title]) =>
    `- [${title.replace(/[[\]]/g, "\\$&")}](${url.replace(/[ ()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)})`);
  return { type: "text", text: `\n\nSources:\n${links.join("\n")}` };
}

function fromAnthropicBlock(block: AnthropicContentBlock): ContentBlock | null {
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  // Thinking and web search (`server_tool_use`, `web_search_tool_result`,
  // whose `content` holds encrypted results) are internal: they go back
  // unchanged in the replay; the pages cited show as sources.
  if (block.type === "thinking" || block.type === "server_tool_use" || block.type === "web_search_tool_result") {
    return null;
  }
  // Skip blocks with no text content (safety net)
  if (!block.text) {
    return null;
  }
  return { type: "text", text: block.text };
}
