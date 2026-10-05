import { sha256 } from "@noble/hashes/sha2.js";
import { requestUrl } from "obsidian";
import type { Provider } from "../types";
import type { ChatGPTOAuthService } from "../auth/chatgptOAuth";
import { isRecord, readJson } from "../json";

export interface ModelOption {
  value: string;
  label: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  supportsReasoningSummary?: boolean;
  supportsParallelTools?: boolean;
  /** Anthropic thinking mode the model supports (`capabilities.thinking.types`). */
  thinkingType?: "adaptive" | "enabled";
}
export interface CatalogEntry {
  identity: string;
  provider: Provider;
  fetchedAt: number;
  models: ModelOption[];
}
export interface CatalogState {
  entries: CatalogEntry[];
  /** Latest stable Codex CLI version, sent as `client_version` (see codexClientVersion). */
  clientVersion?: { value: string; checkedAt: number };
}
export const CATALOG_TTL = 24 * 60 * 60 * 1000;
const RETRY_DELAY = 5 * 60 * 1000;
/** Used when GitHub can't be reached; only has to be recent. */
const FALLBACK_CLIENT_VERSION = "0.160.0";
let versionRequest: Promise<string> | undefined;
let versionAttempt = 0;
const activeModels = new Map<Provider, ModelOption[]>();
const pending = new Map<string, Promise<ModelOption[]>>();
const failedAt = new Map<string, number>();

/** Validate untrusted persisted data; never persist credentials. */
export function normalizeCatalogState(value: unknown): CatalogState {
  const state: CatalogState = { entries: [] };
  if (!isRecord(value)) return state;
  if (Array.isArray(value.entries)) {
    for (const entry of value.entries.slice(-3)) {
      if (!isRecord(entry) || !["anthropic", "openai", "chatgpt-oauth"].includes(String(entry.provider)) ||
          typeof entry.identity !== "string" || !/^[a-f0-9]{64}$/.test(entry.identity) ||
          typeof entry.fetchedAt !== "number" || !Number.isFinite(entry.fetchedAt) || !Array.isArray(entry.models)) continue;
      const models = entry.models.filter(isRecord).filter(m => typeof m.value === "string" && typeof m.label === "string")
        .map((m): ModelOption => ({ value: m.value as string, label: m.label as string,
          reasoningEfforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.filter((e): e is string => typeof e === "string") : undefined,
          defaultReasoningEffort: typeof m.defaultReasoningEffort === "string" ? m.defaultReasoningEffort : undefined,
          supportsReasoningSummary: typeof m.supportsReasoningSummary === "boolean" ? m.supportsReasoningSummary : undefined,
          supportsParallelTools: typeof m.supportsParallelTools === "boolean" ? m.supportsParallelTools : undefined,
          thinkingType: m.thinkingType === "adaptive" || m.thinkingType === "enabled" ? m.thinkingType : undefined }));
      state.entries.push({ identity: entry.identity, provider: entry.provider as Provider, fetchedAt: entry.fetchedAt, models });
    }
  }
  const version = value.clientVersion;
  if (isRecord(version) && typeof version.value === "string" && /^\d+\.\d+\.\d+$/.test(version.value) &&
      typeof version.checkedAt === "number") {
    state.clientVersion = { value: version.value, checkedAt: version.checkedAt };
  }
  return state;
}

/**
 * The ChatGPT model list hides models newer than the `client_version` it is
 * given, like the Codex CLI's catalog it is built on. Without the parameter
 * it assumes an old client (seen 2026-10-05: GPT-6-Sol, GPT-6-Luna and
 * GPT-6.1-Sol were missing). This isn't in OpenAI's docs, so we send the
 * latest stable Codex CLI release, cached for a day. The private Codex
 * voice route (ADR-14) sends it too.
 */
export async function codexClientVersion(state: CatalogState, force: boolean): Promise<string> {
  const known = state.clientVersion;
  if (!force && known && Date.now() - known.checkedAt < CATALOG_TTL) return known.value;
  if (versionRequest) return versionRequest;
  const fallback = known?.value ?? FALLBACK_CLIENT_VERSION;
  if (!force && Date.now() - versionAttempt < RETRY_DELAY) return fallback;
  versionAttempt = Date.now();
  versionRequest = (async () => {
    try {
      const release = await jsonRequest("https://api.github.com/repos/openai/codex/releases/latest", { Accept: "application/vnd.github+json" });
      const version = typeof release.tag_name === "string" ? release.tag_name.match(/^rust-v(\d+\.\d+\.\d+)$/)?.[1] : undefined;
      if (!version || release.prerelease === true || release.draft === true) return fallback;
      state.clientVersion = { value: version, checkedAt: Date.now() };
      return version;
    } catch {
      return fallback;
    }
  })().finally(() => { versionRequest = undefined; });
  return versionRequest;
}
export function getCatalogModels(provider: Provider): ModelOption[] | undefined { return activeModels.get(provider); }
export function clearCatalogModels(provider: Provider): void { activeModels.delete(provider); }
export function catalogModel(provider: Provider, model: string): ModelOption | undefined {
  return activeModels.get(provider)?.find(m => m.value === model);
}
export function oauthParallelTools(model: string): boolean {
  return catalogModel("chatgpt-oauth", model)?.supportsParallelTools !== false;
}
/** The chosen level if the model offers it; otherwise undefined (= the model's default). */
export function resolveThinkingLevel(option: ModelOption | undefined, level: string): string | undefined {
  return level && option?.reasoningEfforts?.includes(level) ? level : undefined;
}
/** Header text for the thinking level, or undefined when the model offers no levels. */
export function thinkingLevelLabel(option: ModelOption | undefined, level: string): string | undefined {
  if (!option?.reasoningEfforts?.length) return undefined;
  const fallback = option.defaultReasoningEffort ? `${option.defaultReasoningEffort} (default)` : "default";
  return resolveThinkingLevel(option, level) ?? fallback;
}
/** ChatGPT reasoning from catalog data only; models without it get no reasoning parameters. */
export function oauthReasoning(model: string, level: string): Record<string, string> | undefined {
  const option = catalogModel("chatgpt-oauth", model);
  const efforts = option?.reasoningEfforts;
  if (!option || !efforts?.length) return undefined;
  const fallback = option.defaultReasoningEffort && efforts.includes(option.defaultReasoningEffort) ? option.defaultReasoningEffort : undefined;
  const effort = resolveThinkingLevel(option, level) ?? fallback;
  const reasoning: Record<string, string> = effort ? { effort } : {};
  if (option.supportsReasoningSummary !== false) reasoning.summary = "auto";
  return Object.keys(reasoning).length ? reasoning : undefined;
}
/** Anthropic thinking from catalog data only; effort is sent only when chosen and offered. */
export function anthropicThinking(model: string, level: string): Record<string, unknown> {
  const option = catalogModel("anthropic", model);
  const params: Record<string, unknown> = {};
  // Adaptive lets Claude decide how much to think; the budget form must stay below max_tokens.
  if (option?.thinkingType === "adaptive") params.thinking = { type: "adaptive" };
  else if (option?.thinkingType === "enabled") params.thinking = { type: "enabled", budget_tokens: 8192 };
  const effort = resolveThinkingLevel(option, level);
  if (effort) params.output_config = { effort };
  return params;
}
/** Read `capabilities.thinking.types` and `capabilities.effort` from Anthropic `/v1/models`. */
function anthropicCapabilities(capabilities: unknown): Pick<ModelOption, "thinkingType" | "reasoningEfforts"> {
  if (!isRecord(capabilities)) return {};
  const types = isRecord(capabilities.thinking) && isRecord(capabilities.thinking.types) ? capabilities.thinking.types : {};
  const supported = (value: unknown) => isRecord(value) && value.supported === true;
  const thinkingType = supported(types.adaptive) ? "adaptive" : supported(types.enabled) ? "enabled" : undefined;
  const effort = capabilities.effort;
  // Levels in the API's key order; "supported" is the flag for effort as a whole.
  const reasoningEfforts = isRecord(effort) && effort.supported === true
    ? Object.entries(effort).filter(([key, value]) => key !== "supported" && supported(value)).map(([key]) => key) : undefined;
  return { thinkingType, reasoningEfforts };
}
export async function catalogIdentity(provider: Provider, secretIdentity: string): Promise<string> {
  // Pure JS hashing also works in mobile WebViews without SubtleCrypto.
  const digest = sha256(new TextEncoder().encode(`${provider}:${secretIdentity}`));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}
export function cachedCatalog(state: CatalogState, provider: Provider, identity: string): CatalogEntry | undefined {
  const entry = state.entries.find(e => e.provider === provider && e.identity === identity);
  if (entry) activeModels.set(provider, entry.models);
  else activeModels.delete(provider);
  return entry;
}
async function jsonRequest(url: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await requestUrl({ url, method: "GET", headers, throw: false });
  if (response.status < 200 || response.status >= 300) throw new Error(`Model catalog request failed (HTTP ${response.status})`);
  const json = readJson(response);
  if (!isRecord(json)) throw new Error("Invalid model catalog response");
  return json;
}
/** Dedupe requests; failures retain the last good entry and use a short retry backoff. */
export async function refreshCatalog(state: CatalogState, provider: Provider, identity: string,
  apiKey: string, oauth: ChatGPTOAuthService, force = false): Promise<ModelOption[]> {
  const entry = cachedCatalog(state, provider, identity);
  if (!force && entry && Date.now() - entry.fetchedAt >= 0 && Date.now() - entry.fetchedAt < CATALOG_TTL) return entry.models;
  if (pending.has(identity)) return pending.get(identity)!;
  if (!force && Date.now() - (failedAt.get(identity) ?? 0) < RETRY_DELAY) return entry?.models ?? [];
  const promise = (async () => {
    let models: ModelOption[];
    if (provider === "chatgpt-oauth") {
      const credential = await oauth.getUsableCredential();
      if (!credential) throw new Error("Continue with ChatGPT first");
      if (await catalogIdentity(provider, credential.accountId || credential.accessToken) !== identity) {
        throw new Error("ChatGPT account changed while loading models; retry for the current account");
      }
      // Same URL as the API-key provider, but this token gets `{models: [...]}`.
      // Reasoning fields aren't in the docs; they are read when present.
      const version = await codexClientVersion(state, force);
      const json = await jsonRequest(`https://api.openai.com/v1/models?client_version=${encodeURIComponent(version)}`,
        { Authorization: `Bearer ${credential.accessToken}` });
      if (!Array.isArray(json.models)) throw new Error("Invalid ChatGPT model catalog");
      models = json.models.filter(isRecord).filter(m => m.visibility === "list" && typeof m.slug === "string")
        .map(m => ({ value: m.slug as string, label: typeof m.display_name === "string" ? m.display_name : m.slug as string,
          reasoningEfforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.filter(isRecord).map(e => e.effort).filter((e): e is string => typeof e === "string") : undefined,
          defaultReasoningEffort: typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : undefined,
          supportsReasoningSummary: typeof m.supports_reasoning_summaries === "boolean" ? m.supports_reasoning_summaries : undefined,
          supportsParallelTools: typeof m.supports_parallel_tool_calls === "boolean" ? m.supports_parallel_tool_calls : undefined }));
    } else {
      const records: Record<string, unknown>[] = [];
      let cursor = "";
      const seen = new Set<string>();
      do {
        const url = provider === "anthropic" ? `https://api.anthropic.com/v1/models?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}` : "https://api.openai.com/v1/models";
        const headers: Record<string, string> = provider === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${apiKey}` };
        const json = await jsonRequest(url, headers);
        if (!Array.isArray(json.data)) throw new Error("Invalid model catalog");
        records.push(...json.data.filter(isRecord));
        if (provider === "anthropic" && json.has_more === true && (typeof json.last_id !== "string" || !json.last_id)) throw new Error("Missing model catalog pagination cursor");
        cursor = provider === "anthropic" && json.has_more === true && typeof json.last_id === "string" ? json.last_id : "";
        if (cursor && seen.has(cursor)) throw new Error("Model catalog pagination did not advance");
        seen.add(cursor);
        if (seen.size > 100) throw new Error("Model catalog pagination limit exceeded");
      } while (cursor);
      models = records.filter(m => typeof m.id === "string").filter(m => provider === "anthropic" ? m.type === "model" :
        /^(gpt-|o\d|chatgpt-|codex-)/.test(String(m.id)) && !/realtime|audio|transcri|search|image|embedding/.test(String(m.id)))
        .map(m => ({ value: m.id as string, label: typeof m.display_name === "string" ? m.display_name : m.id as string,
          ...(provider === "anthropic" ? anthropicCapabilities(m.capabilities) : {}) }));
    }
    models = [...new Map(models.map(m => [m.value, m])).values()];
    if (!models.length) throw new Error("No compatible models returned; keeping the previous list");
    state.entries = state.entries.filter(e => e.provider !== provider);
    state.entries.push({ provider, identity, fetchedAt: Date.now(), models });
    activeModels.set(provider, models);
    failedAt.delete(identity);
    return models;
  })().catch(error => { failedAt.set(identity, Date.now()); throw error; }).finally(() => pending.delete(identity));
  pending.set(identity, promise);
  return promise;
}
