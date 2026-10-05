/**
 * The Responses API, shared by the OpenAI and ChatGPT adapters: the request
 * (tools, history as input items, sending and its errors) and the answer
 * (stream events, output items). Also the replay rule for all adapters.
 */
import type { ContentBlock, ImageAttachment, Provider, ProviderReplay, StreamOptions, UnifiedMessage, UnifiedResponse, UnifiedToolDef } from "../types";
import { withoutOldToolImages } from "../agent/history";
import { streamSSE, type StreamResult } from "./stream";
import { isRecord } from "../json";

/** The ChatGPT route takes function tools only inside a namespace; this is ours. */
export const CHATGPT_TOOL_NAMESPACE = "vault";

/**
 * Whether an assistant message's native items (thinking signatures,
 * encrypted reasoning, search results) go back as they are: they came from
 * `provider` and were recorded for this model and account, or before
 * either was recorded. Otherwise its plain content goes instead, since a
 * provider rejects items made for another model or account. A request
 * whose own model or account isn't known replays only unrecorded items:
 * the rule is the same for all three adapters.
 */
export function canReplay(message: UnifiedMessage, provider: Provider, model: string, identity: string): message is UnifiedMessage & { replay: ProviderReplay } {
  const replay = message.replay;
  return message.role === "assistant" && replay?.provider === provider &&
    (!replay.model || replay.model === model) && (!replay.identity || replay.identity === identity);
}

/** Our tools as Responses API function tools. */
export function functionTools(tools: UnifiedToolDef[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: false,
  }));
}

/** A failure the stream reported (`error`, `response.failed`). */
export interface ResponsesFailure {
  message: string;
  code?: string;
}

/** The adapter's errors for an HTTP error answer and for a failure inside the stream. */
export interface ResponsesErrors {
  http(response: StreamResult): Error;
  stream(failure: ResponsesFailure): Error;
}

/**
 * Sends a streamed Responses request with a bearer token; returns the
 * completed response as the non-streamed API would. `name` names the
 * provider in the error for a stream that ends too early.
 */
export async function sendResponsesRequest(
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
  stream: StreamOptions,
  name: string,
  errors: ResponsesErrors,
): Promise<Record<string, unknown>> {
  const collected = collectResponsesStream(stream.onTextDelta);
  const response = await streamSSE(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  }, collected.onEvent, stream.signal);
  if (response.status < 200 || response.status >= 300) throw errors.http(response);
  const { data, failure } = collected.finish();
  if (failure) throw errors.stream(failure);
  if (!data) throw new Error(`${name} stream ended without a completed response.`);
  return data;
}

/** Encode both fresh input and restored history without losing tool pairs. */
export function buildResponsesInput(
  messages: UnifiedMessage[],
  provider: Extract<Provider, "openai" | "chatgpt-oauth">,
  model: string,
  identity: string,
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const message of withoutOldToolImages(messages)) {
    if (canReplay(message, provider, model, identity)) {
      items.push(...message.replay.items);
      continue;
    }
    const content: Record<string, unknown>[] = [];
    const flush = () => {
      if (content.length) {
        items.push({ type: "message", role: message.role, content: content.splice(0) });
      }
    };
    const blocks: ContentBlock[] = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        content.push(message.role === "assistant"
          ? { type: "output_text", text: block.text, annotations: [] }
          : { type: "input_text", text: block.text });
      } else if (block.type === "image" && block.image && message.role === "user") {
        content.push(inputImage(block.image));
      } else if (block.type === "tool_use" && block.id && block.name) {
        flush();
        items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}),
          ...(provider === "chatgpt-oauth" ? { namespace: CHATGPT_TOOL_NAMESPACE } : {}) });
      } else if (block.type === "tool_result" && block.tool_use_id) {
        flush();
        items.push({ type: "function_call_output", call_id: block.tool_use_id, output: functionOutput(block) });
      }
    }
    flush();
  }
  return items;
}

/**
 * A tool result's `output`. With images it is a content array: the Responses
 * API reference allows `output` to be a string or an array of `input_text`,
 * `input_image` and `input_file` items (developers.openai.com/api/reference,
 * "Create a model response", function_call_output). The ChatGPT route takes
 * the same request format and accepts images (siwc preview limitations), so
 * both providers get the image inside the result rather than in an extra
 * user message.
 */
function functionOutput(block: ContentBlock): string | Record<string, unknown>[] {
  const text = block.content ?? "";
  if (!block.images?.length) return text;
  return [{ type: "input_text", text: text || "(image)" }, ...block.images.map(inputImage)];
}

function inputImage(image: ImageAttachment): Record<string, unknown> {
  return { type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}`, detail: "auto" };
}

/** Preserve native reasoning/search/refusal items even when they have no UI block. */
export function fromResponsesOutput(
  data: Record<string, unknown>,
  provider: Extract<Provider, "openai" | "chatgpt-oauth">,
  model?: string,
  identity?: string,
): UnifiedResponse {
  if (data.status === "failed" || data.error) {
    const error = isRecord(data.error) ? data.error.message : undefined;
    throw new Error(typeof error === "string" ? error : "Response failed.");
  }
  const output = Array.isArray(data.output) ? data.output.filter(isRecord) : [];
  const content: ContentBlock[] = [];
  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content.filter(isRecord)) {
        if (part.type === "output_text" && typeof part.text === "string") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "refusal" && typeof part.refusal === "string") {
          content.push({ type: "text", text: part.refusal });
        }
      }
    } else if (item.type === "function_call" && data.status !== "incomplete") {
      if (typeof item.call_id !== "string" || typeof item.name !== "string") {
        throw new Error("Response contained an invalid tool call.");
      }
      const raw = typeof item.arguments === "string" ? item.arguments : "";
      let input: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        input = isRecord(parsed) ? parsed : { _raw: raw };
      } catch {
        input = { _raw: raw };
      }
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
    }
  }
  const usage = isRecord(data.usage) ? data.usage : undefined;
  return {
    content,
    replay: { provider, model, identity, items: output },
    stopReason: data.status === "incomplete" ? "max_tokens" : content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: usage ? { inputTokens: numberValue(usage.input_tokens), outputTokens: numberValue(usage.output_tokens) } : undefined,
  };
}

/**
 * Collects a streamed Responses answer (`stream: true`). Text deltas go to
 * `onTextDelta` as they arrive. The response is rebuilt from the
 * `response.output_item.done` items, because `response.completed` may carry
 * an empty `output` (always on the ChatGPT route with `store: false`); the
 * terminal event gives id, status and usage. `finish()` returns the same
 * object the non-streamed API returns, or the failure the stream reported.
 */
function collectResponsesStream(onTextDelta?: (text: string) => void): {
  onEvent: (event: Record<string, unknown>) => void;
  finish: () => { data?: Record<string, unknown>; failure?: ResponsesFailure };
} {
  const items = new Map<string | number, Record<string, unknown>>();
  let completed: Record<string, unknown> | undefined;
  let failure: ResponsesFailure | undefined;
  return {
    onEvent: (event) => {
      const type = event.type;
      if (type === "response.output_text.delta") {
        if (typeof event.delta === "string" && event.delta) onTextDelta?.(event.delta);
      } else if (type === "response.output_item.done") {
        if (isRecord(event.item)) {
          const index = event.output_index;
          const key = typeof index === "number" || typeof index === "string" ? index
            : typeof event.item.id === "string" ? event.item.id : items.size;
          items.set(key, event.item);
        }
      } else if (type === "response.completed") {
        completed = isRecord(event.response) ? event.response : {};
      } else if (type === "response.incomplete") {
        completed = { ...(isRecord(event.response) ? event.response : {}), status: "incomplete" };
      } else if (type === "response.failed") {
        const error = isRecord(event.response) && isRecord(event.response.error) ? event.response.error : {};
        failure = {
          message: typeof error.message === "string" ? error.message : "Response failed.",
          code: typeof error.code === "string" ? error.code : undefined,
        };
      } else if (type === "error" && typeof event.message === "string") {
        failure = { message: event.message, code: typeof event.code === "string" ? event.code : undefined };
      }
    },
    finish: () => {
      if (failure) return { failure };
      if (!completed) return {};
      return { data: { ...completed, output: items.size > 0 ? Array.from(items.values()) : completed.output ?? [] } };
    },
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

