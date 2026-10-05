/**
 * ChatGPT adapter: OpenAI's Responses API, paid by the user's ChatGPT plan
 * through "Sign in with ChatGPT" (ADR-13).
 *
 * Rules of this route (docs: siwc/token-sharing-open-source, "Models and
 * inference" and "Preview limitations"):
 * - `store: false` and `stream: true` on every request; success only after
 *   `response.completed`. `requestUrl()` buffers the stream, so the SSE
 *   text is parsed after it ends (ADR-01).
 * - No `previous_response_id`: the full history is replayed in `input`.
 * - Function tools must be grouped in a namespace.
 */
import { requestUrl } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
} from "../types";
import { CHATGPT_OAUTH_DEFAULT_MODEL } from "../types";
import { buildResponsesInput, fromResponsesOutput, CHATGPT_TOOL_NAMESPACE } from "./responses-format";
import { oauthReasoning, oauthParallelTools, cachedCatalog, catalogIdentity } from "./model-catalog";
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

  return sendOnce(body, credential.accessToken, identity);
}

async function sendOnce(
  body: Record<string, unknown>,
  accessToken: string,
  identity: string,
): Promise<UnifiedResponse> {
  let response;
  try {
    response = await requestUrl({
      url: CHATGPT_RESPONSES_URL,
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e: unknown) {
    const err = asRecord(e);
    const status = typeof err.status === "number" || typeof err.status === "string" ? String(err.status) : "";
    const message = typeof err.message === "string" ? err.message : String(e);
    throw new ChatGPTOAuthError(`ChatGPT request failed (${status}): ${message}`);
  }

  if (response.status < 200 || response.status >= 300) {
    // Errors come as `{error: {code, message}}` or, before the request is
    // admitted, `{detail: "..."}`. The .json getter throws on iOS for
    // non-JSON bodies.
    let json: Record<string, unknown> | undefined;
    try {
      json = asOptionalRecord(response.json);
    } catch {
      json = undefined;
    }
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

  const data = parseResponseBody(response);
  return fromResponsesOutput(data, "chatgpt-oauth", typeof body.model === "string" ? body.model : undefined, identity);
}

function parseResponseBody(response: {
  text?: string;
  json?: unknown;
}): Record<string, unknown> {
  // On iOS Obsidian, `requestUrl()` returns a `response.json` that is a
  // lazy getter calling `JSON.parse(text)` under the hood. When the body
  // is SSE (always, with `stream: true`), accessing
  // `.json` throws a SyntaxError like
  //   `JSON Parse error: Unexpected identifier "event"`
  // because the text starts with `event: ...`. Desktop Electron returns
  // undefined / null instead of throwing, but mobile is stricter. We
  // wrap the access in try/catch so we always cleanly fall through to
  // the SSE text parser below.
  let jsonObj: Record<string, unknown> | undefined;
  try {
    jsonObj = asOptionalRecord(response.json);
  } catch {
    jsonObj = undefined;
  }
  if (jsonObj && (jsonObj.output || jsonObj.id)) {
    return jsonObj;
  }

  const text = response.text ?? "";
  if (!text) {
    throw new ChatGPTOAuthError("ChatGPT response was empty.");
  }

  // SSE: lines beginning with `data: ` are JSON events. The response is
  // rebuilt client-side, because `response.completed` may carry an empty
  // `output` (as the former Codex route always did).
  //
  // Strategy:
  //   1. Walk every event in order.
  //   2. Collect each `response.output_item.done` item (deduplicated by
  //      `output_index`, latest write wins). These are the FINAL forms
  //      of the output items — they include the full `content` array
  //      for messages and the complete `arguments` string for tool
  //      calls.
  //   3. Use `response.completed` only as the "stream finished" signal
  //      and to extract the response id and usage stats.
  //   4. Surface `response.failed` / `error` events as exceptions.
  const events = parseSSE(text);
  const itemByIndex = new Map<string | number, Record<string, unknown>>();
  let completedResponse: Record<string, unknown> | null = null;
  let failureMessage: string | null = null;

  for (const evt of events) {
    const type = stringValue(evt.type);
    if (type === "response.output_item.done") {
      const item = asOptionalRecord(evt.item);
      if (item) {
        const key = outputKey(evt.output_index) ?? (stringValue(item.id) || itemByIndex.size);
        itemByIndex.set(key, item);
      }
    } else if (type === "response.completed") {
      completedResponse = asOptionalRecord(evt.response) ?? {};
    } else if (type === "response.incomplete") {
      completedResponse = { ...(asOptionalRecord(evt.response) ?? {}), status: "incomplete" };
    } else if (type === "response.failed") {
      // Usage limits can arrive here after the stream has started.
      const code = getNestedString(evt.response, ["error", "code"]);
      const message = getNestedString(evt.response, ["error", "message"]) ?? "ChatGPT response failed";
      failureMessage = code && USAGE_LIMIT_CODES.includes(code) ? `${message} (${code}). Manage usage: ${USAGE_URL}`
        : code ? `${message} (${code})` : message;
    } else if (type === "error" && typeof evt.message === "string") {
      failureMessage = evt.message;
    }
  }

  if (failureMessage) throw new ChatGPTOAuthError(failureMessage);

  if (completedResponse) {
    // Synthesize a Responses-API-shaped object from the streamed pieces.
    const synthesized: Record<string, unknown> = {
      ...(completedResponse ?? {}),
      output: itemByIndex.size > 0 ? Array.from(itemByIndex.values()) : completedResponse.output ?? [],
    };
    return synthesized;
  }

  throw new ChatGPTOAuthError(
    "ChatGPT stream ended without a completed response.",
  );
}

function parseSSE(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  // SSE events are separated by blank lines. Each event has `data:` lines
  // (potentially multi-line JSON) and optional `event:` / `id:` lines we
  // can ignore — the JSON payload always carries `type`.
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") continue;
    try {
      const event: unknown = JSON.parse(payload);
      if (isRecord(event)) events.push(event);
    } catch {
      // ignore malformed event
    }
  }
  return events;
}

function outputKey(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
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
