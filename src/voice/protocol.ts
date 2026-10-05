/**
 * Live voice wire format (ADR-11): the events on the WebRTC data channel,
 * in two dialects.
 *
 * - `live`: OpenAI's documented GPT-Live events (`session.*`).
 * - `v3`: the names Codex's internal voice route uses (ADR-14,
 *   `input_transcript.added`, `delegation.created`, …).
 *
 * Both are parsed always; the controller picks the outbound dialect from
 * the first dialect-specific event it receives.
 */
import type { ChatHistoryEntry } from "../types";
import { isRecord } from "../json";

export type VoiceDialect = "live" | "v3";

/** A server event, reduced to what the controller needs. */
export type VoiceEvent =
  | { kind: "started" }
  | { kind: "input"; text: string }
  | { kind: "output"; text: string }
  | { kind: "turn-done"; role: "user" | "assistant"; text: string }
  /** `text` is empty when the event carries no task text (GPT-Live). */
  | { kind: "delegation"; id: string; text: string }
  | { kind: "error"; message: string }
  | { kind: "closed"; reason: string }
  | { kind: "other" };

/** A text message seeding the voice model with the recent chat. */
export interface VoiceItem {
  type: "message";
  role: "user" | "assistant";
  content: { type: "input_text" | "output_text"; text: string }[];
}

/** Our instructions for the voice model, the same on both routes. */
export const VOICE_INSTRUCTIONS = `You are the voice of Chatting with AI Minus, an assistant inside the user's Obsidian vault. You only talk; a separate agent with access to the user's notes and tools does the work.
- Delegate every request about the user's notes, vault or files, and anything that needs facts, lookups or tools, to the client. Don't answer those yourself.
- While a delegated task runs, don't guess or invent its result. Say briefly that you're on it, then wait for the result.
- When the result arrives, tell it in short, natural spoken sentences. Don't read out tables, code or long lists; say the details are in the chat.
- Keep replies short. Stop speaking as soon as the user interrupts.`;

/** Answers longer than this are cut and point to the chat. */
export const MAX_SPOKEN_CHARS = 3000;
/** GPT-Live allows 500 tokens per append; ~1500 characters stay below. */
const LIVE_CHUNK_CHARS = 1500;
/** Codex's route limits each appended text to 500 bytes. */
const V3_CHUNK_BYTES = 500;
const SEED_ENTRIES = 8;
const SEED_ENTRY_CHARS = 1000;

const LIVE_TYPES = new Set([
  "session.input_transcript.delta", "session.output_transcript.delta", "session.delegation.created",
  "session.closed", "session.usage.updated",
]);
const V3_TYPES = new Set(["input_transcript.added", "output_transcript.added", "turn.done", "delegation.created"]);

const str = (value: unknown): string => typeof value === "string" ? value : "";

/** The dialect an event type belongs to, if it belongs to only one. */
export function eventDialect(type: string): VoiceDialect | undefined {
  if (LIVE_TYPES.has(type)) return "live";
  if (V3_TYPES.has(type)) return "v3";
  return undefined;
}

/** Parse a data-channel message (either dialect). */
export function parseVoiceEvent(message: unknown): VoiceEvent {
  if (!isRecord(message)) return { kind: "other" };
  switch (message.type) {
    case "session.started":
      return { kind: "started" };
    case "session.input_transcript.delta":
      return { kind: "input", text: str(message.delta) };
    case "session.output_transcript.delta":
      return { kind: "output", text: str(message.delta) };
    case "input_transcript.added":
      return { kind: "input", text: isRecord(message.item) ? str(message.item.text) : "" };
    case "output_transcript.added":
      return { kind: "output", text: isRecord(message.item) ? str(message.item.text) : "" };
    case "turn.done": {
      const turn = isRecord(message.turn) ? message.turn : {};
      const role = turn.role === "user" || turn.role === "assistant" ? turn.role : undefined;
      return role ? { kind: "turn-done", role, text: str(turn.transcript) } : { kind: "other" };
    }
    case "session.delegation.created": {
      const delegation = isRecord(message.delegation) ? message.delegation : {};
      const id = str(delegation.id);
      return id && delegation.target === "client" ? { kind: "delegation", id, text: "" } : { kind: "other" };
    }
    case "delegation.created": {
      const item = isRecord(message.item) ? message.item : {};
      const id = str(item.id);
      if (!id || (item.target !== undefined && item.target !== "client")) return { kind: "other" };
      const text = Array.isArray(item.content)
        ? item.content.filter(isRecord).filter((part) => part.type === "input_text").map((part) => str(part.text)).join("")
        : "";
      return { kind: "delegation", id, text };
    }
    case "error": {
      const error = isRecord(message.error) ? message.error : message;
      return { kind: "error", message: str(error.message) || str(error.code) || "The voice session reported an error." };
    }
    case "session.closed":
      return { kind: "closed", reason: str(message.reason) };
    default:
      return { kind: "other" };
  }
}

/** Events that hand a delegation's result to the voice model to say. */
export function speakEvents(dialect: VoiceDialect, delegationId: string, text: string): Record<string, unknown>[] {
  return dialect === "live"
    ? chunks(text, (part) => part.length <= LIVE_CHUNK_CHARS)
      .map((content) => ({ type: "session.commentary.append", delegation_id: delegationId, content }))
    : v3Append(delegationId, "speakable", text);
}

/** Events that tell the voice model about progress, without saying it. */
export function progressEvents(dialect: VoiceDialect, delegationId: string, text: string): Record<string, unknown>[] {
  return dialect === "live"
    ? chunks(text, (part) => part.length <= LIVE_CHUNK_CHARS)
      .map((content) => ({ type: "session.thinking.append", delegation_id: delegationId, content }))
    : v3Append(delegationId, "commentary", text);
}

export const CLOSE_EVENT = { type: "session.close" };

function v3Append(delegationId: string, channel: "speakable" | "commentary", text: string): Record<string, unknown>[] {
  const encoder = new TextEncoder();
  return chunks(text, (part) => encoder.encode(part).length <= V3_CHUNK_BYTES).map((part) => ({
    type: "delegation.context.append",
    delegation_item_id: delegationId,
    channel,
    content: [{ type: "input_text", text: part }],
  }));
}

/** An answer as it is spoken: long ones are cut and point to the chat. */
export function spokenAnswer(text: string): string {
  if (text.length <= MAX_SPOKEN_CHARS) return text;
  const cut = text.slice(0, MAX_SPOKEN_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return `${(end > MAX_SPOKEN_CHARS / 2 ? cut.slice(0, end + 1) : cut).trim()}\n\nThe full answer is in the chat.`;
}

/**
 * Split `text` into parts that `fits`, at whitespace where possible and
 * never inside a character (UTF-8 safe for the byte limit).
 */
export function chunks(text: string, fits: (part: string) => boolean): string[] {
  const parts: string[] = [];
  let current = "";
  // Words with their trailing whitespace (no lookbehind: older iOS lacks it).
  for (const word of text.match(/\s+|\S+\s*/g) ?? []) {
    if (fits(current + word)) {
      current += word;
      continue;
    }
    if (current) parts.push(current);
    current = "";
    for (const char of word) {
      if (current && !fits(current + char)) {
        parts.push(current);
        current = "";
      }
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The last few chat messages as text, so the voice model knows the context. */
export function seedItems(history: ChatHistoryEntry[]): VoiceItem[] {
  return history
    .filter((entry) => (entry.type === "user" || entry.type === "assistant") && entry.text?.trim())
    .slice(-SEED_ENTRIES)
    .map((entry) => {
      const role = entry.type === "user" ? "user" : "assistant";
      const text = entry.text!.trim();
      return {
        type: "message",
        role,
        content: [{
          type: role === "user" ? "input_text" : "output_text",
          text: text.length > SEED_ENTRY_CHARS ? `${text.slice(0, SEED_ENTRY_CHARS)}…` : text,
        }],
      };
    });
}
