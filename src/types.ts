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
  /** Enter sends (Shift+Enter: new line); off: Enter is a new line, Ctrl/Cmd+Enter sends. */
  enterSends: boolean;
  /** Show each edit the AI makes: its note or canvas opens at the changed spot (`ui/show-in-view.ts`). */
  followEdits: boolean;
  /** The one-time "You're using your ChatGPT plan" welcome was shown. */
  chatgptPlanWelcomeShown: boolean;
  /** Write `debug.log` in the plugin folder (troubleshooting; logs messages, never keys). */
  debugLog: boolean;
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
  enterSends: true,
  followEdits: true,
  chatgptPlanWelcomeShown: false,
  debugLog: false,
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

/**
 * A file for the model (`files/attachments.ts`, ADR-17): a PDF or Office
 * document as base64 `data` (with `text` read from Office files, for
 * providers that don't read them), or a text file as `text` only.
 */
export interface FileAttachment {
  id: string;
  fileName: string;
  /** The document's type; `text/plain` for a file sent as its text. */
  mediaType: string;
  /** Base64 bytes without a data-URL prefix; empty for text files and in the saved visible history. */
  data: string;
  sizeBytes: number;
  text?: string;
}

export interface ContentBlock {
  type: "text" | "image" | "file" | "tool_use" | "tool_result";
  text?: string;
  image?: ImageAttachment;
  file?: FileAttachment;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  /** tool_result only: images the tool returned (view_image, view_canvas). */
  images?: ImageAttachment[];
  /** tool_result only: files the tool returned (read_file on a PDF or Office file). */
  files?: FileAttachment[];
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
  /** What was said in the voice conversation since the last request (context for this one). */
  voiceTranscript?: VoiceTurn[];
  /** What the user did since the last turn that the model should know (e.g. undid an answer's changes). */
  notes?: string[];
}

/** The files a message links to, for the model (`ui/mentions.ts`): their text, and images as images. */
export interface MentionContext {
  text: string;
  images: ImageAttachment[];
  /** PDF and Office files, sent as files where the provider reads them (ADR-17). */
  files: FileAttachment[];
}

/** One turn of a voice conversation: what the user or the voice said. */
export interface VoiceTurn {
  role: "user" | "assistant";
  text: string;
}

// ─── Selection Scope ────────────────────────────────────────────────────────

export interface SelectionScope {
  /** The selected text */
  text: string;
  /** Path to the file containing the selection */
  filePath: string;
  /** Where the selection starts in the note (character offset), so a repeated text isn't mistaken for it. */
  from?: number;
}

// ─── Chat View History ──────────────────────────────────────────────────────

/** One entry of the visible chat history (`plugin.chatHistory`). */
export interface ChatHistoryEntry {
  type: "user" | "assistant" | "tool-result" | "error" | "changes";
  text?: string;
  images?: ImageAttachment[];
  /** User entries: attached files (saved without data and text; restored from the API history). */
  attachedFiles?: FileAttachment[];
  /** User entries: the turn's ID, shared with the agent history; changes entries: their turn. */
  turnId?: string;
  /** User entries: the selection scope the turn ran with. */
  selection?: SelectionScope;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: { result: string; isError: boolean };
  /** Error entries shown in their own way. */
  errorKind?: ChatErrorKind;
  /** Changes entries (at the end of a turn): the files the turn changed. */
  files?: string[];
  /** Changes entries: the user undid them. */
  undone?: boolean;
}

/** Errors the chat shows with their own message and actions. */
export type ChatErrorKind = "usage-limit" | "stopped";

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
  /** Files for the model (read_file on a PDF or Office file); like images, only in the agent history. */
  files?: FileAttachment[];
  /** What a tool changed, for showing it to the user; never sent to the model or saved. */
  focus?: ViewTarget;
}

/** A spot to show in a note (character range) or canvas (card IDs). */
export interface ViewTarget {
  path: string;
  /** Range in the note's text after the change. */
  from?: number;
  to?: number;
  /** Canvas cards. */
  nodes?: string[];
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
  /** Where the turn's tools record their vault changes (undo per answer). */
  changes?: import("./tools/undo").ChangeLog;
}
