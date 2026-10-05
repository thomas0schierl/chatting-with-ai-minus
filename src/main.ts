import {
  Plugin,
  Notice,
  type MarkdownFileInfo,
  type Editor,
  Menu,
  TFile,
  type TAbstractFile,
} from "obsidian";
import type { ChatSettings, SelectionScope, ChatHistoryEntry, ConversationSummary } from "./types";
import { DEFAULT_SETTINGS, DEFAULT_PROVIDER_MODELS } from "./types";
import { ChatSettingTab, getModelHeaderLabel } from "./settings";
import { ObsidianChatView, VIEW_TYPE_CHAT } from "./ui/chat-view";
import { AgentLoop } from "./agent/loop";
import {
  CHAT_STATE_VERSION,
  conversationTitle,
  isEmptyConversation,
  migrateChatState,
  newConversation,
  newestFirst,
  restoreImages,
  savedConversation,
  SAVED_MESSAGES,
  type ChatState,
  type ConversationRecord,
} from "./chat-state";
import { ChatGPTOAuthStore } from "./auth/chatgptOAuthStore";
import { ChatGPTOAuthService } from "./auth/chatgptOAuth";
import { cachedCatalog, catalogIdentity, codexClientVersion, normalizeCatalogState } from "./api/model-catalog";
import { setChatGPTOAuthService } from "./api/chatgpt-oauth";
import { PLUGIN_ID } from "./plugin-id";
import { runCapabilityCheck } from "./diagnostics/capability-check";
import type { VoiceRoute } from "./voice/session";
import { openAILiveRoute } from "./voice/openai-live";
import { CodexVoiceAuth, codexVoiceRoute } from "./voice/codex";

export default class ChatPlugin extends Plugin {
  settings: ChatSettings = DEFAULT_SETTINGS;
  /** Shared agent loop that persists across view open/close cycles */
  agent!: AgentLoop;
  /** ChatGPT OAuth service (used by the chatgpt-oauth provider). */
  chatgptOAuth!: ChatGPTOAuthService;
  /** The Codex sign-in for voice; private builds only (ADR-14). */
  codexVoice?: CodexVoiceAuth;
  /**
   * All conversations. The active one's API history lives in `agent` and
   * is copied into its record when saving or switching.
   */
  conversations: ConversationRecord[] = [newConversation()];
  activeConversationId = this.conversations[0].id;
  /** Set once the saved chat has been read; saving earlier would overwrite it with an empty one. */
  private chatHistoryLoaded = false;

  get activeConversation(): ConversationRecord {
    return this.conversations.find((conversation) => conversation.id === this.activeConversationId)
      ?? this.conversations[0];
  }

  /** The active conversation's messages, for replaying into the UI when the view reopens. */
  get chatHistory(): ChatHistoryEntry[] {
    return this.activeConversation.chatHistory;
  }

  set chatHistory(entries: ChatHistoryEntry[]) {
    this.activeConversation.chatHistory = entries;
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    // Wire ChatGPT OAuth before constructing the agent: the OAuth API client
    // looks up the service via setChatGPTOAuthService().
    const oauthStore = new ChatGPTOAuthStore(this.app);
    this.chatgptOAuth = new ChatGPTOAuthService(oauthStore);
    setChatGPTOAuthService(this.chatgptOAuth);
    if (__CODEX_VOICE__) this.codexVoice = new CodexVoiceAuth(this.app);
    // The chat header shows the thinking level from the saved catalog.
    await this.activateModelCatalog();

    this.agent = new AgentLoop(this.app, this.settings);

    // Restore persisted chat history
    await this.loadChatHistory();

    this.addSettingTab(new ChatSettingTab(this.app, this));

    // Register sidebar view (loads deferred by default in v1.7.2+)
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ObsidianChatView(leaf, this));

    // Ribbon icon (users can hide; commands are the primary access)
    this.addRibbonIcon("message-circle", "Open Chatting with AI Minus", (evt) => {
      if (evt.type === "contextmenu" || evt.button === 2) {
        // Right-click: show menu with options
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Open chat").setIcon("message-circle").onClick(() => void this.openChat())
        );
        menu.addItem((item) =>
          item.setTitle("New chat").setIcon("square-pen").onClick(() => void this.newChat())
        );
        menu.addItem((item) =>
          item.setTitle("Chat about active note").setIcon("file-text").onClick(() => void this.chatAboutActiveNote())
        );
        menu.addItem((item) =>
          item.setTitle("Copy transcript").setIcon("clipboard").onClick(() => this.shareTranscript())
        );
        menu.showAtMouseEvent(evt);
      } else {
        void this.openChat();
      }
    });

    // ─── Commands ────────────────────────────────────────────────────────

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => void this.openChat(),
    });

    this.addCommand({
      id: "new-chat",
      name: "New chat",
      callback: () => void this.newChat(),
    });

    this.addCommand({
      id: "copy-transcript",
      name: "Copy conversation transcript to clipboard",
      callback: () => this.shareTranscript(),
    });

    this.addCommand({
      id: "clear-chat",
      name: "Clear conversation",
      callback: () => this.clearChat(),
    });

    // Diagnostics for live voice and streaming on this device (ADR-11, ADR-12)
    this.addCommand({
      id: "check-device-capabilities",
      name: "Check device capabilities (voice, streaming)",
      callback: () => void runCapabilityCheck(this.app, {
        openai: this.loadApiKey("openai"),
        anthropic: this.loadApiKey("anthropic"),
      }),
    });

    // Editor command: chat about the current note (only when editor is active)
    this.addCommand({
      id: "chat-about-note",
      name: "Chat about this note",
      editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
        void this.openChatWithMessage(`Summarize this note: ${ctx.file?.path ?? "the active document"}`);
      },
    });

    // Editor command: chat about selected text (conditional, only when text is selected)
    this.addCommand({
      id: "send-selection",
      name: "Send selection to chat",
      editorCheckCallback: (checking: boolean, editor: Editor, ctx: MarkdownFileInfo) => {
        const sel = editor.getSelection();
        if (!sel || sel.length === 0) return false;
        if (checking) return true;
        const scope: SelectionScope = { text: sel, filePath: ctx.file?.path ?? "" };
        void this.openChatWithSelection(scope);
        return true;
      },
    });

    // ─── Context menus ──────────────────────────────────────────────────

    // File explorer context menu
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Chat about this note")
            .setIcon("message-circle")
            .onClick(() => void this.openChatWithMessage(`Tell me about ${file.path}`))
        );
      })
    );

    // Editor right-click context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownFileInfo) => {
        const sel = editor.getSelection();
        if (sel && sel.length > 0) {
          menu.addItem((item) =>
            item
              .setTitle("Send selection to chat")
              .setIcon("message-circle")
              .onClick(() => {
                const scope: SelectionScope = { text: sel, filePath: info.file?.path ?? "" };
                void this.openChatWithSelection(scope);
              })
          );
        }
      })
    );
  }

  onunload(): void {
    this.getChatView()?.endVoice();
    void this.saveChatHistory();
  }

  /**
   * The voice route the settings choose, or null when it isn't set up: an
   * OpenAI API key (official), or in private builds the Codex sign-in
   * (ADR-14).
   */
  voiceRoute(): VoiceRoute | null {
    const s = this.settings;
    if (__CODEX_VOICE__ && s.voiceRoute === "codex") {
      const auth = this.codexVoice;
      if (!auth?.getCredential()) return null;
      return codexVoiceRoute(auth, s.codexVoice, () => codexClientVersion(s.modelCatalog ??= { entries: [] }, false));
    }
    const key = this.loadApiKey("openai");
    return key ? openAILiveRoute(key, s.voice) : null;
  }

  /**
   * Save the OpenAI API key from the voice settings. It is the OpenAI
   * provider's key too, so the provider's copy in the settings follows.
   */
  async saveOpenAIKey(key: string): Promise<void> {
    this.saveApiKey("openai", key);
    if (this.settings.provider === "openai") this.settings.apiKey = key;
    await this.saveSettings();
  }

  // ─── Chat operations ────────────────────────────────────────────────

  /**
   * True if the active provider is configured enough to send a message.
   * - anthropic / openai: an API key is set.
   * - chatgpt-oauth: a credential is present in SecretStorage.
   */
  private isProviderConfigured(): boolean {
    if (this.settings.provider === "chatgpt-oauth") {
      return !!this.chatgptOAuth?.getCredential();
    }
    return !!this.settings.apiKey;
  }

  private notConfiguredMessage(): string {
    if (this.settings.provider === "chatgpt-oauth") {
      return "Connect your ChatGPT account in Chatting with AI Minus settings.";
    }
    return "Please configure your API key in Chatting with AI Minus settings.";
  }

  private async openChat(): Promise<void> {
    if (!this.isProviderConfigured()) {
      new Notice(this.notConfiguredMessage());
      return;
    }
    await this.activateView();
  }

  /** Open chat and immediately send a message */
  private async openChatWithMessage(message: string): Promise<void> {
    if (!this.isProviderConfigured()) {
      new Notice(this.notConfiguredMessage());
      return;
    }
    await this.activateView();
    const view = this.getChatView();
    if (view) {
      // A new topic: in a new conversation, like the chat apps.
      window.setTimeout(() => {
        view.newChat();
        view.sendMessage(message);
      }, 100);
    }
  }

  /** Open a new chat with a selection scope (shows pill, user types their own question) */
  private async openChatWithSelection(selection: SelectionScope): Promise<void> {
    if (!this.isProviderConfigured()) {
      new Notice(this.notConfiguredMessage());
      return;
    }
    await this.activateView();
    const view = this.getChatView();
    if (view) {
      window.setTimeout(() => {
        view.newChat();
        view.setSelection(selection);
        view.focus();
      }, 100);
    }
  }

  private async chatAboutActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note.");
      return;
    }
    await this.openChatWithMessage(`Tell me about ${file.path}`);
  }

  /** Open or reveal the chat view in the right sidebar (both desktop and mobile). */
  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT);

    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }

    // Right sidebar on both desktop and mobile.
    // On mobile, this slides in as a panel from the right edge.
    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      await workspace.revealLeaf(leaf);
    }
  }

  /** Get the active ObsidianChatView using proper instanceof check (deferred view safe) */
  private getChatView(): ObsidianChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    for (const leaf of leaves) {
      if (leaf.view instanceof ObsidianChatView) {
        return leaf.view;
      }
    }
    return null;
  }

  private shareTranscript(): void {
    const view = this.getChatView();
    if (!view) {
      new Notice("No active conversation.");
      return;
    }

    const transcript = view.getTranscript();
    if (!transcript || transcript.endsWith("## Conversation\n\n")) {
      new Notice("Conversation is empty.");
      return;
    }

    navigator.clipboard.writeText(transcript).then(() => {
      new Notice("Transcript copied to clipboard.");
    }).catch(() => {
      new Notice("Failed to copy transcript.");
    });
  }

  private clearChat(): void {
    const view = this.getChatView();
    if (view) {
      view.clearConversation();
      new Notice("Conversation cleared.");
    } else {
      new Notice("No active conversation.");
    }
  }

  /** Opens the chat on a new conversation. */
  private async newChat(): Promise<void> {
    const view = this.getChatView();
    if (view) view.newChat();
    else this.startNewConversation();
    await this.openChat();
  }

  // ─── Conversations ──────────────────────────────────────────────────
  // The view stops a running turn before calling these.

  /** Conversations with content, most recently used first (the history list). */
  listConversations(): ConversationSummary[] {
    this.storeActiveMessages();
    return newestFirst(this.conversations)
      .filter((conversation) => !isEmptyConversation(conversation))
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt, active: id === this.activeConversationId }));
  }

  /** Makes a new empty conversation active; an empty active one is kept instead. */
  startNewConversation(): void {
    this.storeActiveMessages();
    if (isEmptyConversation(this.activeConversation)) return;
    const conversation = newConversation();
    this.conversations.push(conversation);
    this.activate(conversation);
  }

  /** Makes conversation `id` active. */
  openConversation(id: string): void {
    const next = this.conversations.find((conversation) => conversation.id === id);
    if (!next || next.id === this.activeConversationId) return;
    this.storeActiveMessages();
    this.activate(next);
  }

  /** Renames conversation `id`; an empty name goes back to the automatic title. */
  renameConversation(id: string, title: string): void {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) return;
    const name = title.replace(/\s+/g, " ").trim();
    conversation.customTitle = name !== "";
    conversation.title = name || conversationTitle(conversation.chatHistory);
    void this.saveChatHistory();
  }

  /** Deletes conversation `id`; deleting the active one opens the most recent other, or a new one. */
  deleteConversation(id: string): void {
    const deleted = this.conversations.find((conversation) => conversation.id === id);
    if (!deleted) return;
    this.conversations = this.conversations.filter((conversation) => conversation !== deleted);
    if (deleted.id === this.activeConversationId) {
      const next = newestFirst(this.conversations)[0] ?? newConversation();
      if (!this.conversations.includes(next)) this.conversations.push(next);
      this.agent.abort();
      this.activeConversationId = next.id;
      this.agent.importMessages(next.agentMessages);
    }
    void this.saveChatHistory();
  }

  /** Called when a turn starts or the conversation is cleared: order and title. */
  touchConversation(): void {
    const conversation = this.activeConversation;
    conversation.updatedAt = Date.now();
    if (!conversation.customTitle) conversation.title = conversationTitle(conversation.chatHistory);
  }

  /** Switches the agent to `next`; an empty conversation left behind is dropped. */
  private activate(next: ConversationRecord): void {
    const previous = this.activeConversation;
    this.agent.abort();
    this.activeConversationId = next.id;
    // A new history array: OpenAI can't chain to the other conversation's responses.
    this.agent.importMessages(next.agentMessages);
    if (previous !== next && isEmptyConversation(previous)) {
      this.conversations = this.conversations.filter((conversation) => conversation !== previous);
    }
    void this.saveChatHistory();
  }

  /** Copies the agent's history into the active conversation's record. */
  private storeActiveMessages(): void {
    if (this.agent) this.activeConversation.agentMessages = this.agent.exportMessages(SAVED_MESSAGES);
  }

  // ─── Chat history persistence ─────────────────────────────────────────

  async saveChatHistory(): Promise<void> {
    if (!this.chatHistoryLoaded) return;
    try {
      this.storeActiveMessages();
      const state: ChatState = {
        version: CHAT_STATE_VERSION,
        activeConversationId: this.activeConversationId,
        // Per conversation: the last 100 UI entries and 80 API messages
        // (complete turns); image data only in the API history.
        conversations: this.conversations
          .filter((conversation) => conversation.id === this.activeConversationId || !isEmptyConversation(conversation))
          .map(savedConversation),
      };
      await this.app.vault.adapter.write(
        this.chatStatePath,
        JSON.stringify(state)
      );
    } catch {
      // Persistence is best-effort
    }
  }

  private async loadChatHistory(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(this.chatStatePath);
      const state = migrateChatState(JSON.parse(raw));
      if (!state) return;
      for (const conversation of state.conversations) {
        conversation.chatHistory = restoreImages(conversation.chatHistory, conversation.agentMessages);
      }
      this.conversations = state.conversations;
      this.activeConversationId = state.activeConversationId;
      this.agent.importMessages(this.activeConversation.agentMessages);
    } catch {
      // No saved state or parse error — start fresh
    } finally {
      this.chatHistoryLoaded = true;
    }
  }

  // ─── Settings persistence ────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const saved = normalizeSettings(await this.loadData());
    this.settings = { ...DEFAULT_SETTINGS, ...saved };

    // Fall back to default model if saved model is empty
    if (!this.settings.model) {
      this.settings.model = DEFAULT_PROVIDER_MODELS[this.settings.provider];
    }

    // Load API key for the current provider from SecretStorage
    this.settings.apiKey = this.loadApiKey(this.settings.provider);
  }

  async saveSettings(): Promise<void> {
    // Store API key in SecretStorage keyed by provider
    this.saveApiKey(this.settings.provider, this.settings.apiKey || "");

    // Save all other settings to data.json (syncs), but strip the API key
    const toSave = { ...this.settings, apiKey: "" };
    await this.saveData(toSave);

    // Update the chat view header with the new model name and thinking level
    const view = this.getChatView();
    view?.updateModel(this.modelHeaderLabel(), this.settings.provider);
    view?.updateVoiceAvailable();
  }

  /** Model name and thinking level, as shown in the chat view header. */
  modelHeaderLabel(): string {
    const { provider, model, thinkingLevel } = this.settings;
    return getModelHeaderLabel(provider, model, thinkingLevel);
  }

  /** Activate the saved model catalog of the current provider and account (no network). */
  private async activateModelCatalog(): Promise<void> {
    const { provider, apiKey, modelCatalog } = this.settings;
    const credential = provider === "chatgpt-oauth" ? this.chatgptOAuth.getCredential() : null;
    const secretIdentity = provider === "chatgpt-oauth" ? credential?.accountId || credential?.accessToken : apiKey;
    if (!secretIdentity || !modelCatalog) return;
    cachedCatalog(modelCatalog, provider, await catalogIdentity(provider, secretIdentity));
  }

  /** Load the correct API key when provider changes */
  reloadApiKeyForProvider(): void {
    this.settings.apiKey = this.loadApiKey(this.settings.provider);
  }

  loadApiKey(provider: string): string {
    try {
      return this.app.secretStorage.getSecret(`${PLUGIN_ID}-api-key-${provider}`) || "";
    } catch {
      return "";
    }
  }

  private saveApiKey(provider: string, key: string): void {
    try {
      this.app.secretStorage.setSecret(`${PLUGIN_ID}-api-key-${provider}`, key);
    } catch {
      // SecretStorage not available
    }
  }

  private get pluginDataDir(): string {
    return `${this.app.vault.configDir}/plugins/${PLUGIN_ID}`;
  }

  private get chatStatePath(): string {
    return `${this.pluginDataDir}/chat-state.json`;
  }
}

function normalizeSettings(value: unknown): Partial<ChatSettings> {
  if (!isRecord(value)) return {};
  const settings: Partial<ChatSettings> = {};
  if (isProvider(value.provider)) settings.provider = value.provider;
  if (typeof value.apiKey === "string") settings.apiKey = value.apiKey;
  if (typeof value.model === "string") settings.model = value.model;
  if (typeof value.thinkingLevel === "string") settings.thinkingLevel = value.thinkingLevel;
  if (typeof value.maxIterations === "number") settings.maxIterations = value.maxIterations;
  if (typeof value.enableWebSearch === "boolean") settings.enableWebSearch = value.enableWebSearch;
  if (typeof value.chatgptPlanWelcomeShown === "boolean") settings.chatgptPlanWelcomeShown = value.chatgptPlanWelcomeShown;
  settings.modelCatalog = normalizeCatalogState(value.modelCatalog);
  if (value.voiceRoute === "openai" || value.voiceRoute === "codex") settings.voiceRoute = value.voiceRoute;
  if (typeof value.voice === "string" && value.voice) settings.voice = value.voice;
  if (typeof value.codexVoice === "string" && value.codexVoice) settings.codexVoice = value.codexVoice;
  if (value.voiceMicMode === "hands-free" || value.voiceMicMode === "hold") settings.voiceMicMode = value.voiceMicMode;
  return settings;
}

function isProvider(value: unknown): value is ChatSettings["provider"] {
  return value === "anthropic" || value === "openai" || value === "chatgpt-oauth";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
