/**
 * The official voice route (ADR-11): OpenAI GPT-Live with client
 * delegation, created with the user's OpenAI API key through
 * `requestUrl()`.
 */
import { requestUrl } from "obsidian";
import type { VoiceRoute } from "./session";

const API = "https://api.openai.com/v1";
export const LIVE_MODEL = "gpt-live-1";
export const DEFAULT_LIVE_VOICE = "marin";
/**
 * GPT-Live's built-in voices, from the API reference (`audio.output.voice`,
 * 2026-10-05). No endpoint lists them, so this is the one hardcoded list
 * (an exception to ADR-08, noted in ADR-11).
 */
export const LIVE_VOICES = [
  "alloy", "ash", "aube", "ballad", "beacon", "bossa", "brise", "cedar", "cinder", "coral", "delta",
  "echo", "flitz", "gleam", "harema", "juni", "marin", "meridian", "nira", "noeul", "nuri", "quartz",
  "ripple", "sage", "shimmer", "shitan", "sillage", "stone", "tempo", "verse", "vesper", "willow",
];

/** A route that creates GPT-Live sessions with this API key and voice. */
export function openAILiveRoute(apiKey: string, voice: string): VoiceRoute {
  return {
    name: "openai",
    dialect: "live",
    waitForStarted: true,
    async connect({ sdp, instructions, items }) {
      const response = await requestUrl({
        url: `${API}/live/sessions`,
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          session: {
            model: LIVE_MODEL,
            instructions,
            audio: { output: { voice: voice || DEFAULT_LIVE_VOICE } },
            delegation: { type: "client" },
            ...(items.length ? { input: items } : {}),
          },
          transport: { type: "webrtc", sdp },
        }),
        throw: false,
      });
      let json: unknown;
      try {
        json = response.json;
      } catch {
        json = undefined;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Couldn't start voice (HTTP ${response.status})${errorText(json)}`);
      }
      const body = (json ?? {}) as { session?: { id?: unknown }; transport?: { sdp?: unknown } };
      if (typeof body.transport?.sdp !== "string") throw new Error("Couldn't start voice: the answer had no connection details.");
      return { sdp: body.transport.sdp, callId: typeof body.session?.id === "string" ? body.session.id : undefined };
    },
  };
}

/** Whether this API key's model list includes GPT-Live. */
export async function hasLiveAccess(apiKey: string): Promise<boolean> {
  const response = await requestUrl({ url: `${API}/models`, headers: { Authorization: `Bearer ${apiKey}` }, throw: false });
  if (response.status < 200 || response.status >= 300) throw new Error(`Couldn't check the key (HTTP ${response.status})`);
  let json: unknown;
  try {
    json = response.json;
  } catch {
    return false;
  }
  const data = (json as { data?: unknown } | undefined)?.data;
  return Array.isArray(data) && data.some((model: unknown) => (model as { id?: unknown } | null)?.id === LIVE_MODEL);
}

function errorText(json: unknown): string {
  const error = (json as { error?: { message?: unknown } } | undefined)?.error;
  return typeof error?.message === "string" && error.message ? `: ${error.message}` : "";
}
