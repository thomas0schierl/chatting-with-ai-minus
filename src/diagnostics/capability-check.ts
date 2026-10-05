/**
 * "Check device capabilities": answers, on the device it runs on, the open
 * questions behind ADR-11 (live voice over WebRTC) and ADR-12 (streaming
 * with fetch). Results are shown in a modal and can be copied; API keys are
 * never included.
 */
import { App, Modal, Notice, Platform, apiVersion, requestUrl } from "obsidian";
import { browserFetch } from "../api/stream";

type Status = "ok" | "fail" | "skip";

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
}

export interface CapabilityKeys {
  openai: string;
  anthropic: string;
}

const OPENAI = "https://api.openai.com/v1";
const ANTHROPIC = "https://api.anthropic.com/v1";
const CONNECT_TIMEOUT_MS = 15_000;

export async function runCapabilityCheck(app: App, keys: CapabilityKeys): Promise<void> {
  const modal = new CapabilityModal(app);
  modal.open();
  const run = async (name: string, check: () => Promise<[Status, string]>) => {
    modal.add({ name, status: "skip", detail: "running…" });
    try {
      const [status, detail] = await check();
      modal.replaceLast({ name, status, detail });
    } catch (e) {
      modal.replaceLast({ name, status: "fail", detail: message(e) });
    }
  };

  await run("Platform", async () => ["ok", describePlatform()]);
  await run("Microphone (getUserMedia)", checkMicrophone);
  await run("WebRTC (local offer)", checkLocalWebRTC);
  await run("Streaming fetch: OpenAI", () => checkOpenAIStreaming(keys.openai));
  await run("Streaming fetch: Anthropic", () => checkAnthropicStreaming(keys.anthropic));
  await run("Live voice: OpenAI Realtime over WebRTC", () => checkRealtime(keys.openai));
  modal.done();
}

// ─── Checks ─────────────────────────────────────────────────────────────────

function describePlatform(): string {
  const kind = Platform.isIosApp ? "iOS app" : Platform.isAndroidApp ? "Android app" : Platform.isDesktopApp ? "desktop app" : "other";
  const os = Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "";
  const form = Platform.isPhone ? "phone" : Platform.isTablet ? "tablet" : "";
  return [kind, os, form, `Obsidian API ${apiVersion}`, `origin ${window.location.origin}`].filter(Boolean).join("; ");
}

async function checkMicrophone(): Promise<[Status, string]> {
  if (!navigator.mediaDevices?.getUserMedia) return ["fail", "navigator.mediaDevices.getUserMedia is missing"];
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const tracks = stream.getAudioTracks();
  const label = tracks[0]?.label || "unnamed device";
  stream.getTracks().forEach((t) => t.stop());
  return tracks.length > 0 ? ["ok", `audio track from ${label}`] : ["fail", "no audio track"];
}

async function checkLocalWebRTC(): Promise<[Status, string]> {
  if (typeof RTCPeerConnection === "undefined") return ["fail", "RTCPeerConnection is missing"];
  const pc = new RTCPeerConnection();
  try {
    pc.createDataChannel("probe");
    await pc.setLocalDescription(await pc.createOffer());
    const candidates = await gatherCandidates(pc, 3000);
    return ["ok", `offer created; ICE candidates: ${candidates.join(", ") || "none within 3 s"}`];
  } finally {
    pc.close();
  }
}

function gatherCandidates(pc: RTCPeerConnection, timeoutMs: number): Promise<string[]> {
  const types: string[] = [];
  return new Promise((resolve) => {
    const finish = () => resolve(types);
    window.setTimeout(finish, timeoutMs);
    pc.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return finish();
      const type = event.candidate.type ?? "unknown";
      if (!types.includes(type)) types.push(type);
    });
  });
}

/** Without a key: proves only that the browser may call the API (CORS). */
async function checkOpenAIStreaming(apiKey: string): Promise<[Status, string]> {
  if (!apiKey) {
    const res = await browserFetch(`${OPENAI}/responses`, { method: "POST", headers: { Authorization: "Bearer invalid", "Content-Type": "application/json" }, body: "{}" });
    return ["ok", `CORS allowed (HTTP ${res.status} readable). Set an OpenAI key to test streaming.`];
  }
  const model = await newestModel(apiKey, (id) => /^gpt-/.test(id) && !/realtime|audio|transcri|search|image|tts/.test(id));
  if (!model) return ["fail", "no chat model found in /v1/models"];
  return streamProbe(`${OPENAI}/responses`, { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    { model, input: "Count from 1 to 30, one number per line.", stream: true, store: false }, model);
}

async function checkAnthropicStreaming(apiKey: string): Promise<[Status, string]> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey || "invalid",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "content-type": "application/json",
  };
  if (!apiKey) {
    const res = await browserFetch(`${ANTHROPIC}/messages`, { method: "POST", headers, body: "{}" });
    return ["ok", `CORS allowed (HTTP ${res.status} readable). Set an Anthropic key to test streaming.`];
  }
  const models = await (await browserFetch(`${ANTHROPIC}/models?limit=20`, { headers })).json() as { data?: Array<{ id: string }> };
  const model = models.data?.[0]?.id;
  if (!model) return ["fail", "no model found in /v1/models"];
  return streamProbe(`${ANTHROPIC}/messages`, headers,
    { model, max_tokens: 200, stream: true, messages: [{ role: "user", content: "Count from 1 to 30, one number per line." }] }, model);
}

/** Reads a streamed response chunk by chunk, then checks that abort works. */
async function streamProbe(url: string, headers: Record<string, string>, body: unknown, model: string): Promise<[Status, string]> {
  const started = Date.now();
  const res = await browserFetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok || !res.body) return ["fail", `HTTP ${res.status} with ${model}: ${(await res.text()).slice(0, 200)}`];
  const reader = res.body.getReader();
  let chunks = 0;
  let firstChunkMs = 0;
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
    if (chunks++ === 0) firstChunkMs = Date.now() - started;
  }
  const totalMs = Date.now() - started;

  const controller = new AbortController();
  const aborted = await browserFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal })
    .then(async (r) => { const rd = r.body!.getReader(); await rd.read(); controller.abort(); await rd.read(); return "not aborted"; })
    .catch((e: unknown) => (e instanceof DOMException && e.name === "AbortError" ? "abort works" : `abort error: ${message(e)}`));

  const streamed = chunks > 1 && firstChunkMs < totalMs;
  return [streamed ? "ok" : "fail",
    `${model}: ${chunks} chunks, first after ${firstChunkMs} ms, done after ${totalMs} ms; ${aborted}`];
}

async function checkRealtime(apiKey: string): Promise<[Status, string]> {
  if (!apiKey) return ["skip", "needs an OpenAI API key"];
  const model = await newestModel(apiKey, (id) => id.startsWith("gpt-realtime"));
  if (!model) return ["fail", "no gpt-realtime model in /v1/models"];

  const secret = await requestUrl({
    url: `${OPENAI}/realtime/client_secrets`,
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    contentType: "application/json",
    body: JSON.stringify({ session: { type: "realtime", model } }),
    throw: false,
  });
  if (secret.status !== 200) return ["fail", `client secret: HTTP ${secret.status} ${secret.text.slice(0, 200)}`];
  const ephemeral = (secret.json as { value?: string }).value;
  if (!ephemeral) return ["fail", "client secret response has no value"];

  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const pc = new RTCPeerConnection();
  try {
    mic.getAudioTracks().forEach((t) => pc.addTrack(t, mic));
    const events: string[] = [];
    const channel = pc.createDataChannel("oai-events");
    channel.addEventListener("message", (e) => {
      const type = (JSON.parse(String(e.data)) as { type?: string }).type;
      if (type && !events.includes(type)) events.push(type);
    });
    await pc.setLocalDescription(await pc.createOffer());

    const answer = await requestUrl({
      url: `${OPENAI}/realtime/calls`,
      method: "POST",
      headers: { Authorization: `Bearer ${ephemeral}` },
      contentType: "application/sdp",
      body: pc.localDescription?.sdp ?? "",
      throw: false,
    });
    if (answer.status < 200 || answer.status >= 300) return ["fail", `SDP exchange: HTTP ${answer.status} ${answer.text.slice(0, 200)}`];
    const location = answer.headers["location"] ?? answer.headers["Location"] ?? "not exposed";
    await pc.setRemoteDescription({ type: "answer", sdp: answer.text });

    const state = await waitFor(() => (channel.readyState === "open" && events.length > 0 ? "connected" : null), CONNECT_TIMEOUT_MS);
    return [state ? "ok" : "fail",
      `${model}; SDP answer ${answer.text.length} bytes; Location header: ${location}; ` +
      `connection ${pc.connectionState}; data channel ${channel.readyState}; events: ${events.join(", ") || "none"}`];
  } finally {
    pc.close();
    mic.getTracks().forEach((t) => t.stop());
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Diagnostic only: picks the newest model matching a pattern. */
async function newestModel(apiKey: string, match: (id: string) => boolean): Promise<string | undefined> {
  const res = await requestUrl({ url: `${OPENAI}/models`, headers: { Authorization: `Bearer ${apiKey}` }, throw: false });
  if (res.status !== 200) return undefined;
  const data = (res.json as { data?: Array<{ id: string; created: number }> }).data ?? [];
  return data.filter((m) => match(m.id)).sort((a, b) => b.created - a.created)[0]?.id;
}

function waitFor<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const value = probe();
      if (value !== null) return resolve(value);
      if (Date.now() - started > timeoutMs) return resolve(null);
      window.setTimeout(tick, 200);
    };
    tick();
  });
}

function message(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

// ─── Results modal ──────────────────────────────────────────────────────────

class CapabilityModal extends Modal {
  private results: CheckResult[] = [];
  private listEl!: HTMLElement;
  private copyButton!: HTMLButtonElement;

  onOpen(): void {
    this.setTitle("Device capability check");
    this.listEl = this.contentEl.createDiv();
    this.copyButton = this.contentEl.createEl("button", { text: "Copy results" });
    this.copyButton.disabled = true;
    this.copyButton.addEventListener("click", () => {
      navigator.clipboard.writeText(this.asText())
        .then(() => new Notice("Results copied."))
        .catch(() => new Notice("Failed to copy results."));
    });
  }

  add(result: CheckResult): void {
    this.results.push(result);
    this.render();
  }

  replaceLast(result: CheckResult): void {
    this.results[this.results.length - 1] = result;
    this.render();
  }

  done(): void {
    this.copyButton.disabled = false;
  }

  private asText(): string {
    return this.results.map((r) => `${symbol(r.status)} ${r.name}: ${r.detail}`).join("\n");
  }

  private render(): void {
    this.listEl.empty();
    for (const r of this.results) {
      const row = this.listEl.createEl("p");
      row.createEl("strong", { text: `${symbol(r.status)} ${r.name}` });
      row.createEl("br");
      row.createSpan({ text: r.detail });
    }
  }
}

function symbol(status: Status): string {
  return status === "ok" ? "✓" : status === "fail" ? "✗" : "–";
}
