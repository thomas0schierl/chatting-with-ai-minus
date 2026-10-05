import type { ChatErrorKind, ChatSettings, UnifiedMessage, UnifiedToolDef, UnifiedResponse, StreamOptions } from "../types";
import { sendAnthropicMessage } from "./anthropic";
import { sendOpenAIMessage } from "./openai";
import { sendChatGPTOAuthMessage } from "./chatgpt-oauth";
import { ChatGPTUsageLimitError } from "../auth/chatgptOAuth";
import { ProviderError } from "./errors";

/** HTTP statuses of a rate limit or an overload. */
const RETRY_STATUSES = [429, 529];
/** The same inside a stream: Anthropic's error types, OpenAI's code. */
const RETRY_CODES = ["rate_limit_error", "overloaded_error", "rate_limit_exceeded"];
/** Wait before the retry when the provider names none, and the longest wait. */
const RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Dispatches a message to the appropriate provider adapter.
 * Handles single retry on a rate limit or overload (429, 529, or such an
 * error inside the stream), but only while no answer text has been shown:
 * a retry would show it twice.
 * A ChatGPT usage limit (also 429) is its own error class and not retried.
 */
export async function sendMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string,
  shouldStop: () => boolean = () => false,
  stream: StreamOptions = {},
): Promise<UnifiedResponse> {
  let shown = false;
  const options: StreamOptions = {
    signal: stream.signal,
    onTextDelta: (text) => {
      shown = true;
      stream.onTextDelta?.(text);
    },
  };
  const doSend = () => {
    if (shouldStop()) throw new Error("Request cancelled.");
    if (settings.provider === "anthropic") {
      return sendAnthropicMessage(settings, messages, tools, systemPrompt, options);
    }
    if (settings.provider === "chatgpt-oauth") {
      return sendChatGPTOAuthMessage(settings, messages, tools, systemPrompt, options);
    }
    return sendOpenAIMessage(settings, messages, tools, systemPrompt, options);
  };

  try {
    return await doSend();
  } catch (e) {
    if (isRateLimit(e) && !shown) {
      await sleep(Math.min(e.retryAfterMs ?? RETRY_DELAY_MS, MAX_RETRY_DELAY_MS));
      return await doSend();
    }
    throw e;
  }
}

/** How the chat shows an error from `sendMessage`; undefined for a plain error message. */
export function errorKind(e: unknown): ChatErrorKind | undefined {
  return e instanceof ChatGPTUsageLimitError ? "usage-limit" : undefined;
}

function isRateLimit(e: unknown): e is ProviderError {
  return e instanceof ProviderError &&
    (RETRY_STATUSES.includes(e.status) || (e.code !== undefined && RETRY_CODES.includes(e.code)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
