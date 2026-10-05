import type { ChatErrorKind, ChatSettings, UnifiedMessage, UnifiedToolDef, UnifiedResponse, StreamOptions } from "../types";
import { sendAnthropicMessage } from "./anthropic";
import { sendOpenAIMessage } from "./openai";
import { sendChatGPTOAuthMessage } from "./chatgpt-oauth";
import { ChatGPTUsageLimitError } from "../auth/chatgptOAuth";

/**
 * Dispatches a message to the appropriate provider adapter.
 * Handles single retry on a rate limit or overload (429, 529, or such an
 * error inside the stream), but only while no answer text has been shown:
 * a retry would show it twice.
 * A ChatGPT usage limit (also 429) is not retried.
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
    // Single retry on rate limit
    if (isRateLimitError(e) && !shown) {
      const retryAfter = extractRetryAfter(e);
      const delay = retryAfter ? retryAfter * 1000 : 5000;
      await sleep(Math.min(delay, 30000));
      return await doSend();
    }
    throw e;
  }
}

/** How the chat shows an error from `sendMessage`; undefined for a plain error message. */
export function errorKind(e: unknown): ChatErrorKind | undefined {
  return e instanceof ChatGPTUsageLimitError ? "usage-limit" : undefined;
}

function isRateLimitError(e: unknown): boolean {
  if (e instanceof ChatGPTUsageLimitError) return false;
  if (e instanceof Error) {
    // HTTP 429 or 529, or an error inside the stream such as Anthropic's
    // `rate_limit_error` or `overloaded_error`.
    return /\b(429|529)\b|rate.?limit|overloaded/i.test(e.message);
  }
  return false;
}

function extractRetryAfter(e: unknown): number | null {
  if (e instanceof Error) {
    const match = e.message.match(/retry.after[:\s]*(\d+)/i);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
