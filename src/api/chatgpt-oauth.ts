/**
 * ChatGPT adapter: OpenAI's Responses API, paid by the user's ChatGPT plan
 * through "Sign in with ChatGPT" (ADR-13).
 *
 * Rules of this route (docs: siwc/token-sharing-open-source, "Models and
 * inference" and "Preview limitations"):
 * - `store: false` and `stream: true` on every request; success only after
 *   `response.completed`. The answer streams like OpenAI's (ADR-12).
 * - No `previous_response_id`: the full history is replayed in `input`.
 * - Function tools must be grouped in a namespace.
 */
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  StreamOptions,
} from "../types";

import { buildResponsesInput, fromResponsesOutput, functionTools, sendResponsesRequest, CHATGPT_TOOL_NAMESPACE, type ResponsesFailure } from "./responses-format";
import { oauthReasoning, oauthParallelTools, cachedCatalog, catalogIdentity, secretIdentity } from "./model-catalog";
import type { StreamResult } from "./stream";
import { ProviderError } from "./errors";
import { asRecord, getNestedString } from "../json";
import {
  ChatGPTOAuthError,
  ChatGPTUsageLimitError,
  type ChatGPTOAuthService,
} from "../auth/chatgptOAuth";

export const CHATGPT_RESPONSES_URL = "https://api.openai.com/v1/responses";
/** The plan's (or this app's) usage limit is reached. */
const USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
/** Usage couldn't be checked; temporary. */
const USAGE_UNAVAILABLE_CODE = "subscription_sharing_usage_unavailable";

/** Held by main.ts; injected via setChatGPTOAuthService(). */
let oauthService: ChatGPTOAuthService | null = null;

export function setChatGPTOAuthService(service: ChatGPTOAuthService | null): void {
  oauthService = service;
}

/**
 * Reset per-conversation client state (called from AgentLoop.clear()).
 * Nothing to reset: history lives entirely in AgentLoop.messages.
 */
export function clearChatGPTOAuthState(): void {
  /* no-op */
}

export async function sendChatGPTOAuthMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string,
  stream: StreamOptions = {},
): Promise<UnifiedResponse> {
  if (!oauthService) {
    throw new ChatGPTOAuthError("ChatGPT sign-in isn't initialized. Reload the plugin.");
  }

  let credential;
  try {
    credential = await oauthService.getUsableCredential();
  } catch (e) {
    throw new ChatGPTOAuthError(e instanceof Error ? e.message : String(e));
  }
  if (!credential) {
    throw new ChatGPTOAuthError(
      "ChatGPT isn't connected. Open Settings -> Chatting with AI Minus -> Continue with ChatGPT.",
    );
  }

  const identity = await catalogIdentity("chatgpt-oauth", secretIdentity("chatgpt-oauth", settings.apiKey, () => credential));
  cachedCatalog(settings.modelCatalog, "chatgpt-oauth", identity);
  const model = settings.model;

  const body: Record<string, unknown> = {
    model,
    input: buildResponsesInput(messages, "chatgpt-oauth", model, identity),
    instructions: systemPrompt,
    store: false,
    stream: true,
    parallel_tool_calls: oauthParallelTools(model),
  };

  const reasoning = oauthReasoning(model, settings.thinkingLevel);
  if (reasoning) {
    body.reasoning = reasoning;
    // With store:false, reasoning is replayed from its encrypted form.
    body.include = ["reasoning.encrypted_content"];
  }

  const apiTools: Record<string, unknown>[] = [];
  if (tools.length > 0) {
    apiTools.push({
      type: "namespace",
      name: CHATGPT_TOOL_NAMESPACE,
      description: "Read, search and edit notes in the user's Obsidian vault.",
      tools: functionTools(tools),
    });
  }
  if (settings.enableWebSearch) {
    apiTools.push({ type: "web_search" });
  }
  if (apiTools.length > 0) {
    body.tools = apiTools;
  }

  const send = async (accessToken: string) => fromResponsesOutput(
    await sendResponsesRequest(CHATGPT_RESPONSES_URL, accessToken, body, stream, "ChatGPT", CHATGPT_ERRORS),
    "chatgpt-oauth", model, identity);
  try {
    return await send(credential.accessToken);
  } catch (e) {
    // A rejected token (401 comes before any streamed text): refresh once
    // and retry once. A second 401 keeps its "sign in again" error.
    if (!(e instanceof ProviderError) || e.status !== 401) throw e;
    let renewed;
    try {
      renewed = await oauthService.renewRejected(credential);
    } catch (refreshError) {
      throw refreshError instanceof ChatGPTOAuthError ? refreshError : e;
    }
    if (!renewed) throw e;
    return send(renewed.accessToken);
  }
}

/** ChatGPT's errors: a usage limit is its own error; others say how to recover. */
const CHATGPT_ERRORS = {
  http(response: StreamResult): Error {
    // Errors come as `{error: {code, message}}` or, before the request is
    // admitted, `{detail: "..."}`.
    const json = asRecord(response.json);
    const detail = json.detail;
    const code = getNestedString(json, ["error", "code"]);
    const apiMsg =
      (typeof detail === "string" ? detail : getNestedString(detail, ["message"])) ??
      getNestedString(json, ["error", "message"]) ??
      response.text?.slice(0, 300) ??
      `HTTP ${response.status}`;
    if (code === USAGE_LIMIT_CODE) return new ChatGPTUsageLimitError(`${apiMsg} (${code})`);
    const hint = response.status === 401
      ? " Continue with ChatGPT in settings to sign in again."
      : code === USAGE_UNAVAILABLE_CODE ? " Try again in a moment." : "";
    return new ProviderError(`ChatGPT request failed (${response.status}${code ? `, ${code}` : ""}): ${apiMsg}.${hint}`,
      response.status, code, response.retryAfterMs);
  },
  // Usage limits can arrive here after the stream has started.
  stream({ message, code }: ResponsesFailure): Error {
    if (code === USAGE_LIMIT_CODE) return new ChatGPTUsageLimitError(`${message} (${code})`);
    return new ProviderError(code === USAGE_UNAVAILABLE_CODE ? `${message} (${code}). Try again in a moment.`
      : code ? `${message} (${code})` : message, 0, code);
  },
};

