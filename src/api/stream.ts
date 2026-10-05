/**
 * Transport for streamed chat requests (ADR-12): the one place that uses
 * `fetch`. Obsidian's review lint warns about `fetch`; keeping it here keeps
 * that to one warning. Everything else uses `requestUrl()`.
 *
 * The request is a POST whose answer is Server-Sent Events. Each event's
 * JSON is handed to `onEvent` as it arrives:
 * - Desktop: Node's `https` (Electron), which no CORS check applies to.
 *   Needed for ChatGPT: with a ChatGPT-plan token, `api.openai.com` answers
 *   without CORS headers, so browser `fetch` is blocked (seen 2026-10-05).
 * - Mobile: `fetch`. Anthropic and OpenAI (API key) allow it.
 * If that fails before any response (CORS block, network error), the same
 * request goes through `requestUrl()`, which buffers the whole stream; its
 * events are then delivered at once. Once that fallback has worked for a
 * URL, later requests to it skip `fetch` for this session.
 */
import { Platform, requestUrl } from "obsidian";

export interface StreamRequest {
  headers: Record<string, string>;
  body: string;
}

/** The HTTP status; for errors (not 2xx) also the body, as text and JSON. */
export interface StreamResult {
  status: number;
  text?: string;
  json?: unknown;
}

export type SSEHandler = (event: Record<string, unknown>) => void;

/** URLs where `fetch` failed but `requestUrl()` worked: fetch is blocked there. */
const fetchBlocked = new Set<string>();

/** For tests: forget that `fetch` was blocked. */
export function resetStreamTransport(): void {
  fetchBlocked.clear();
}

export async function streamSSE(
  url: string,
  request: StreamRequest,
  onEvent: SSEHandler,
  signal?: AbortSignal,
): Promise<StreamResult> {
  throwIfAborted(signal);
  const https = nodeHttps();
  if (https) return viaNode(https, url, request, onEvent, signal);
  if (!fetchBlocked.has(url)) {
    let response: Response | undefined;
    try {
      response = await fetch(url, { method: "POST", headers: request.headers, body: request.body, signal });
    } catch {
      throwIfAborted(signal);
      // No response at all: try requestUrl() below.
    }
    if (response) return readFetchResponse(response, onEvent, signal);
    const result = await viaRequestUrl(url, request, onEvent, signal);
    fetchBlocked.add(url);
    return result;
  }
  return viaRequestUrl(url, request, onEvent, signal);
}

// ─── Desktop: Node https ────────────────────────────────────────────────────

interface NodeResponse {
  statusCode?: number;
  setEncoding(encoding: string): void;
  on(event: "data", listener: (chunk: string) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

interface NodeRequest {
  on(event: "error", listener: (error: Error) => void): void;
  write(body: string): void;
  end(): void;
  destroy(): void;
}

interface NodeHttps {
  request(url: string, options: { method: string; headers: Record<string, string> },
    callback: (response: NodeResponse) => void): NodeRequest;
}

/** Node's `https` module on desktop (Electron); undefined on mobile. */
function nodeHttps(): NodeHttps | undefined {
  if (!Platform.isDesktopApp || typeof window === "undefined") return undefined;
  const load = (window as unknown as { require?: (id: string) => unknown }).require;
  try {
    return load?.("https") as NodeHttps | undefined;
  } catch {
    return undefined;
  }
}

function viaNode(https: NodeHttps, url: string, request: StreamRequest, onEvent: SSEHandler,
  signal?: AbortSignal): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const headers = { ...request.headers, "Content-Length": String(new TextEncoder().encode(request.body).length) };
    const req = https.request(url, { method: "POST", headers }, (res) => {
      const status = res.statusCode ?? 0;
      res.setEncoding("utf8");
      const ok = status >= 200 && status < 300;
      const parser = ok ? createSSEParser(onEvent) : undefined;
      let errorText = "";
      res.on("data", (chunk) => {
        if (signal?.aborted) return;
        if (parser) parser.push(chunk);
        else errorText += chunk;
      });
      res.on("error", fail);
      res.on("end", () => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) return reject(new Error("Request cancelled."));
        if (parser) {
          parser.end();
          resolve({ status });
        } else {
          resolve({ status, text: errorText, json: parseJson(errorText) });
        }
      });
    });
    function fail(error: Error) {
      signal?.removeEventListener("abort", abort);
      reject(signal?.aborted ? new Error("Request cancelled.") : error);
    }
    function abort() {
      req.destroy();
      fail(new Error("Request cancelled."));
    }
    signal?.addEventListener("abort", abort);
    req.on("error", fail);
    req.write(request.body);
    req.end();
  });
}

async function readFetchResponse(response: Response, onEvent: SSEHandler, signal?: AbortSignal): Promise<StreamResult> {
  if (!response.ok) {
    const text = await response.text();
    return { status: response.status, text, json: parseJson(text) };
  }
  const parser = createSSEParser(onEvent);
  const reader = response.body?.getReader();
  if (!reader) {
    // No readable body: take it whole.
    const text = await response.text();
    throwIfAborted(signal);
    parser.push(text);
    parser.end();
    return { status: response.status };
  }
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel);
  try {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  return { status: response.status };
}

/** `requestUrl()` can't be cancelled; a stopped request's result is dropped. */
async function viaRequestUrl(url: string, request: StreamRequest, onEvent: SSEHandler, signal?: AbortSignal): Promise<StreamResult> {
  const response = await requestUrl({ url, method: "POST", headers: request.headers, body: request.body, throw: false });
  throwIfAborted(signal);
  let text: string | undefined;
  try {
    text = response.text;
  } catch {
    text = undefined;
  }
  if (response.status < 200 || response.status >= 300) {
    // The .json getter throws on iOS for bodies that aren't JSON.
    let json: unknown;
    try {
      json = response.json as unknown;
    } catch {
      json = undefined;
    }
    return { status: response.status, text, json };
  }
  const parser = createSSEParser(onEvent);
  parser.push(text ?? "");
  parser.end();
  return { status: response.status };
}

/**
 * Incremental Server-Sent Events parser. Text may arrive split anywhere;
 * lines end in LF, CRLF or CR. `data:` lines of one event are joined with
 * newlines and parsed as JSON; comments, `[DONE]` and malformed JSON are
 * skipped. An event without `type` takes it from its `event:` field.
 */
export function createSSEParser(onEvent: SSEHandler): { push(text: string): void; end(): void } {
  let buffer = "";
  let data: string[] = [];
  let eventName = "";

  const dispatch = () => {
    const payload = data.join("\n");
    const name = eventName;
    data = [];
    eventName = "";
    if (!payload || payload === "[DONE]") return;
    const event = parseJson(payload);
    if (typeof event !== "object" || event === null || Array.isArray(event)) return;
    const record = event as Record<string, unknown>;
    if (typeof record.type !== "string" && name) record.type = name;
    onEvent(record);
  };

  const line = (text: string) => {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") eventName = value;
  };

  return {
    push(text: string) {
      buffer += text;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i];
        if (c !== "\n" && c !== "\r") continue;
        // A CR at the end may be the first half of CRLF: wait for more.
        if (c === "\r" && i === buffer.length - 1) break;
        line(buffer.slice(start, i));
        if (c === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
    },
    end() {
      if (buffer) line(buffer.replace(/\r$/, ""));
      buffer = "";
      dispatch();
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Request cancelled.");
}
