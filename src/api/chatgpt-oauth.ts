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
import { CHATGPT_OAUTH_DEFAULT_MODEL } from "../types";
import { buildResponsesInput, collectResponsesStream, fromResponsesOutput, CHATGPT_TOOL_NAMESPACE } from "./responses-format";
import { oauthReasoning, oauthParallelTools, cachedCatalog, catalogIdentity } from "./model-catalog";
import { streamSSE } from "./stream";
import {
  ChatGPTOAuthError,
  USAGE_URL,
  type ChatGPTOAuthService,
} from "../auth/chatgptOAuth";

export const CHATGPT_RESPONSES_URL = "https://api.openai.com/v1/responses";
/** Error codes that mean the plan's (or this app's) usage limit is reached. */
const USAGE_LIMIT_CODES = ["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"];

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

  const identity = await catalogIdentity("chatgpt-oauth", credential.accountId || credential.accessToken);
  if (settings.modelCatalog) {
    cachedCatalog(settings.modelCatalog, "chatgpt-oauth", identity);
  }
  const model = settings.model || CHATGPT_OAUTH_DEFAULT_MODEL;

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
      tools: tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        strict: false,
      })),
    });
  }
  if (settings.enableWebSearch) {
    apiTools.push({ type: "web_search" });
  }
  if (apiTools.length > 0) {
    body.tools = apiTools;
  }

  return sendOnce(body, credential.accessToken, identity, stream);
}

async function sendOnce(
  body: Record<string, unknown>,
  accessToken: string,
  identity: string,
  stream: StreamOptions,
): Promise<UnifiedResponse> {
  const collected = collectResponsesStream(stream.onTextDelta);
  let response;
  try {
    response = await streamSSE(CHATGPT_RESPONSES_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    }, collected.onEvent, stream.signal);
  } catch (e: unknown) {
    const err = asRecord(e);
    const status = typeof err.status === "number" || typeof err.status === "string" ? String(err.status) : "";
    const message = typeof err.message === "string" ? err.message : String(e);
    throw new ChatGPTOAuthError(`ChatGPT request failed (${status}): ${message}`);
  }

  if (response.status < 200 || response.status >= 300) {
    // Errors come as `{error: {code, message}}` or, before the request is
    // admitted, `{detail: "..."}`.
    const json = asOptionalRecord(response.json);
    const detail = json?.detail;
    const code = getNestedString(json, ["error", "code"]);
    const apiMsg =
      (typeof detail === "string" ? detail : getNestedString(detail, ["message"])) ??
      getNestedString(json, ["error", "message"]) ??
      response.text?.slice(0, 300) ??
      `HTTP ${response.status}`;
    const hint = response.status === 401
      ? " Continue with ChatGPT in settings to sign in again."
      : code && USAGE_LIMIT_CODES.includes(code) ? ` Manage usage: ${USAGE_URL}` : "";
    const err = new ChatGPTOAuthError(
      `ChatGPT request failed (${response.status}${code ? `, ${code}` : ""}): ${apiMsg}.${hint}`,
    );
    (err as Error & { status?: number }).status = response.status;
    throw err;
  }

  const { data, failure } = collected.finish();
  if (failure) {
    // Usage limits can arrive here after the stream has started.
    const { message, code } = failure;
    throw new ChatGPTOAuthError(code && USAGE_LIMIT_CODES.includes(code) ? `${message} (${code}). Manage usage: ${USAGE_URL}`
      : code ? `${message} (${code})` : message);
  }
  if (!data) throw new ChatGPTOAuthError("ChatGPT stream ended without a completed response.");
  return fromResponsesOutput(data, "chatgpt-oauth", typeof body.model === "string" ? body.model : undefined, identity);
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

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
