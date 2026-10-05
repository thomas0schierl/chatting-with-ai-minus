// ─── Settings ───────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "chatgpt-oauth";

export interface ChatSettings {
  provider: Provider;
  /** API key for `anthropic` and `openai`. Empty for `chatgpt-oauth` (which uses SecretStorage credentials). */
  apiKey: string;
  model: string;
  /**
   * Thinking level as the provider names it (e.g. `"high"`). Empty = the
   * model's default. Offered levels come from the model catalog.
   */
  thinkingLevel: string;
  maxIterations: number;
  enableWebSearch: boolean;
  /** The one-time "You're using your ChatGPT plan" welcome was shown. */
  chatgptPlanWelcomeShown: boolean;
  /** Model lists per provider and account; set when the settings load. */
  modelCatalog: import("./api/model-catalog").CatalogState;
  /**
   * Live voice (ADR-11): `openai` uses the OpenAI API key; `codex` the
   * separate Codex sign-in, only in private builds (ADR-14).
   */
  voiceRoute: VoiceRouteId;
  /** Voice of the OpenAI route (`audio.output.voice`). */
  voice: string;
  /** Voice of the Codex route. */
  codexVoice: string;
  /** Hands-free (the server detects turns) or hold to talk (mic on while pressed). */
  voiceMicMode: VoiceMicMode;
}

export type VoiceRouteId = "openai" | "codex";
export type VoiceMicMode = "hands-free" | "hold";

/**
 * Each provider's default model: for a new setup, after switching
 * providers, and when no model is saved (`loadSettings()` guarantees one).
 * ChatGPT's applies until the account's own list from `/v1/models` loads.
 */
export const DEFAULT_PROVIDER_MODELS: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-6.1-sol",
  "chatgpt-oauth": "gpt-5.5",
};

/** Defaults; the model catalog is set (empty or saved) when the settings load. */
export const DEFAULT_SETTINGS: Omit<ChatSettings, "modelCatalog"> = {
  provider: "anthropic",
  apiKey: "",
  model: DEFAULT_PROVIDER_MODELS.anthropic,
  thinkingLevel: "",
  maxIterations: 20,
  enableWebSearch: true,
  chatgptPlanWelcomeShown: false,
  voiceRoute: "openai",
  voice: "marin",
  codexVoice: "cove",
  voiceMicMode: "hands-free",
};


// ─── Unified Message Format ─────────────────────────────────────────────────

export interface ImageAttachment {
  id: string;
  fileName: string;
  mediaType: string;
  /** Base64 image bytes without the data-URL prefix. */
  data: string;
  sizeBytes: number;
}

export interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  image?: ImageAttachment;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  /** tool_result only: images the tool returned (view_image, view_canvas). */
  images?: ImageAttachment[];
}

export interface UnifiedMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  /** Exact provider output for replay, separate from user-visible content. */
  replay?: ProviderReplay;
  /**
   * On the message that starts a user turn: the turn's ID, also on its
   * entry in the chat view's history, so both can be cut there.
   */
  turnId?: string;
}

export interface ProviderReplay {
  provider: Provider;
  model?: string;
  identity?: string;
  items: Record<string, unknown>[];
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export interface UnifiedToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── API Response ───────────────────────────────────────────────────────────

export interface UnifiedResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop" | "pause_turn";
  replay?: ProviderReplay;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** Per request: where streamed answer text goes, and how Stop cancels it. */
export interface StreamOptions {
  onTextDelta?: (text: string) => void;
  signal?: AbortSignal;
}

// ─── Conversation Context ───────────────────────────────────────────────────

export interface ConversationContext {
  activeFile: string | null;
  selection: string | null;
  vaultName: string;
  fileCount: number;
  /** The turn comes from a voice conversation; its answer will be spoken. */
  voice?: boolean;
}

// ─── Selection Scope ────────────────────────────────────────────────────────

export interface SelectionScope {
  /** The selected text */
  text: string;
  /** Path to the file containing the selection */
  filePath: string;
}

// ─── Chat View History ──────────────────────────────────────────────────────

/** One entry of the visible chat history (`plugin.chatHistory`). */
export interface ChatHistoryEntry {
  type: "user" | "assistant" | "tool-result" | "error";
  text?: string;
  images?: ImageAttachment[];
  /** User entries: the turn's ID, shared with the agent history. */
  turnId?: string;
  /** User entries: the selection scope the turn ran with. */
  selection?: SelectionScope;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: { result: string; isError: boolean };
  /** Error entries shown in their own way. */
  errorKind?: ChatErrorKind;
}

/** Errors the chat shows with their own message and actions. */
export type ChatErrorKind = "usage-limit";

/** A row of the chat view's history list. */
export interface ConversationSummary {
  id: string;
  title: string;
  /** Last use, in ms. */
  updatedAt: number;
  /** The conversation shown now. */
  active: boolean;
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

export interface ToolResult {
  result: string;
  isError: boolean;
  /**
   * Images for the model. They are kept only in the agent history; the
   * chat view gets the text with a marker instead (`AgentLoop`).
   */
  images?: ImageAttachment[];
}

// ─── Agent Loop Callbacks ───────────────────────────────────────────────────

export interface AgentCallbacks {
  onThinking: () => void;
  /** Answer text as it streams in; `onResponse` later gives the whole text. */
  onTextDelta?: (text: string) => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: ToolResult) => void;
  onResponse: (text: string) => void;
  onAskUser: (question: string) => Promise<string>;
  onError: (error: string, kind?: ChatErrorKind) => void;
  /** A request the user added to the running turn (`AgentLoop.steer`) went out with its next step. */
  onSteered?: (text: string) => void;
  /**
   * A request that failed or stalled in the background is sent again now
   * that Obsidian is back (ADR-15); text streamed by the failed attempt
   * is to be dropped.
   */
  onResuming?: () => void;
}
