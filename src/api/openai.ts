import { cachedCatalog, catalogIdentity } from "./model-catalog";
import { compactThreshold } from "../agent/compaction";
import { activeServers, openaiMcpTools } from "./mcp";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ProviderReplay,
  StreamOptions,
} from "../types";

import { buildResponsesInput, compactionParameter, fromResponsesOutput, functionTools, sendResponsesRequest } from "./responses-format";
import { ProviderError } from "./errors";
import { getNestedString } from "../json";

const DEFAULT_OPENAI_URL = "https://api.openai.com";

interface ConversationState {
  responseId: string;
  model: string;
  apiKey: string;
  messages: UnifiedMessage[];
  replay: ProviderReplay | undefined;
}

// Connection tests and other conversations must never replace this chat's cursor.
let conversations = new WeakMap<UnifiedMessage[], ConversationState>();

export function clearOpenAIState(): void {
  conversations = new WeakMap();
}

/**
 * Sends a message to OpenAI via the Responses API (/v1/responses).
 * Uses the `previous_response_id` field for multi-turn, which lets
 * OpenAI manage conversation state server-side and avoids us having to
 * reconstruct function_call items. The answer is streamed (ADR-12).
 */
export async function sendOpenAIMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string,
  stream: StreamOptions = {},
): Promise<UnifiedResponse> {
  const baseUrl = DEFAULT_OPENAI_URL;
  const model = settings.model;

  const identity = await catalogIdentity("openai", settings.apiKey);
  const previous = conversations.get(messages);
  const canChain = previous?.model === model && previous.apiKey === settings.apiKey &&
    previous.messages.length < messages.length &&
    previous.messages.every((message, index) => message === messages[index]) &&
    messages[previous.messages.length]?.role === "assistant" &&
    messages[previous.messages.length]?.replay === previous.replay;
  // Rebuilt/restored histories include native response items and tool pairs.
  const input = buildResponsesInput(canChain ? messages.slice(previous.messages.length + 1) : messages, "openai", model, identity);

  // The model's window comes from its documentation page (ADR-18).
  const option = cachedCatalog(settings.modelCatalog, "openai", identity)?.models.find((item) => item.value === model);
  const body: Record<string, unknown> = {
    model,
    input,
    stream: true,
    ...compactionParameter(compactThreshold("openai", option)),
  };

  // Chain to previous response for multi-turn context
  if (canChain) {
    body.previous_response_id = previous.responseId;
  }

  // No reasoning parameters: `/v1/models` doesn't report which models reason
  // or which levels they accept, so every model runs on its own default.

  const apiTools = functionTools(tools);
  if (settings.enableWebSearch) apiTools.push({ type: "web_search" });
  // Remote MCP servers, connected by OpenAI (ADR-19).
  apiTools.push(...openaiMcpTools(activeServers(settings)));
  if (apiTools.length > 0) body.tools = apiTools;

  // Always send instructions (system prompt) since previous_response_id
  // doesn't carry forward the system prompt
  body.instructions = systemPrompt;

  const data = await sendResponsesRequest(`${baseUrl}/v1/responses`, settings.apiKey, body, stream, "OpenAI", {
    http: (response) => new ProviderError(
      `OpenAI API error (${response.status}): ${getNestedString(response.json, ["error", "message"]) ?? `HTTP ${response.status}`}`,
      response.status, getNestedString(response.json, ["error", "code"]), response.retryAfterMs),
    stream: ({ message, code }) => new ProviderError(`OpenAI API error${code ? ` (${code})` : ""}: ${message}`, 0, code),
  });

  const result = fromResponsesOutput(data, "openai", model, identity);
  if (typeof data.id === "string") {
    conversations.set(messages, { responseId: data.id, model, apiKey: settings.apiKey, messages: [...messages], replay: result.replay });
  } else {
    conversations.delete(messages);
  }
  return result;
}

