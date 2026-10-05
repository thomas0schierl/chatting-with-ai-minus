<script lang="ts">
  import type { App } from "obsidian";
  import { Component, MarkdownRenderer, Notice } from "obsidian";
  import { onDestroy } from "svelte";
  import type { ToolResult, SelectionScope, ImageAttachment, ConversationSummary, ChatErrorKind } from "../types";
  import { normalizeMathMarkdown } from "./math-markdown";
  import { USAGE_URL } from "../auth/chatgptOAuth";
  import type { VoiceViewState } from "../voice/controller";
  import type { VoiceAction } from "./chat-view";

  const MAX_IMAGE_COUNT = 4;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
  const SUPPORTED_IMAGE_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);

  interface ChatMessage {
    id: number;
    type: "user" | "assistant" | "tool-call" | "tool-result" | "error" | "thinking";
    text?: string;
    images?: ImageAttachment[];
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: ToolResult;
    /** User messages of a turn (not `ask_user` answers): editable. */
    turnId?: string;
    selection?: SelectionScope;
    /** Assistant messages: text still arriving (no actions yet). */
    streaming?: boolean;
    /** Error messages shown in their own way. */
    errorKind?: ChatErrorKind;
  }

  /** Header, title and voice button are set through setModel, setTitle and setVoiceAvailable. */
  interface Props {
    app: App;
    component: Component;
    onSend: (text: string, selection: SelectionScope | null, images: ImageAttachment[]) => void;
    onClear: () => void;
    onStop: () => void;
    onEdit: (turnId: string, text: string) => void;
    onRegenerate: () => void;
    onCopy: (text: string) => void;
    onNewChat: () => void;
    listConversations: () => ConversationSummary[];
    onOpenConversation: (id: string) => void;
    onRenameConversation: (id: string, title: string) => void;
    onDeleteConversation: (id: string) => void;
    onVoice: (action: VoiceAction) => void;
  }

  let {
    app, component, onSend, onClear, onStop, onEdit, onRegenerate, onCopy,
    onNewChat, listConversations, onOpenConversation, onRenameConversation, onDeleteConversation,
    onVoice,
  }: Props = $props();

  // ─── Voice (ADR-11) ───────────────────────────────────────────────────
  /** A voice route is set up: show the microphone button. */
  let canVoice = $state(false);
  let voice = $state<VoiceViewState | null>(null);

  const VOICE_STATUS: Record<VoiceViewState["status"], string> = {
    connecting: "Connecting…",
    listening: "Listening",
    thinking: "Working on it…",
    speaking: "Speaking",
  };

  /** The end of a long caption line. */
  function captionTail(text: string): string {
    const trimmed = text.trim();
    return trimmed.length > 160 ? `…${trimmed.slice(-160)}` : trimmed;
  }

  /** Hold to talk: the microphone is on while the button is pressed. */
  function talkStart(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    onVoice("talk-start");
  }

  function talkKey(event: KeyboardEvent, pressed: boolean): void {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat) return;
    onVoice(pressed ? "talk-start" : "talk-end");
  }

  /** Show the voice bar (null hides it). */
  export function setVoice(state: VoiceViewState | null): void {
    voice = state;
  }

  export function setVoiceAvailable(available: boolean): void {
    canVoice = available;
  }

  let displayModel = $state("");
  let displayProvider = $state("");
  let displayTitle = $state("");

  // ─── History list (a drawer over the chat) ────────────────────────────
  let historyOpen = $state(false);
  let conversations = $state<ConversationSummary[]>([]);
  let renamingId = $state<string | null>(null);
  let renameText = $state("");
  let deletingId = $state<string | null>(null);

  function refreshConversations(): void {
    conversations = listConversations();
  }

  function toggleHistory(): void {
    historyOpen = !historyOpen;
    renamingId = null;
    deletingId = null;
    if (historyOpen) refreshConversations();
  }

  function closeHistory(): void {
    historyOpen = false;
    renamingId = null;
    deletingId = null;
  }

  function newChat(): void {
    closeHistory();
    onNewChat();
  }

  function openConversation(id: string): void {
    closeHistory();
    onOpenConversation(id);
  }

  function startRename(conversation: ConversationSummary): void {
    deletingId = null;
    renamingId = conversation.id;
    renameText = conversation.title;
  }

  /** Saves the name being edited (Enter, or leaving the field). */
  function saveRename(id: string): void {
    if (renamingId !== id) return;
    renamingId = null;
    onRenameConversation(id, renameText);
    refreshConversations();
  }

  function handleRenameKeydown(e: KeyboardEvent, id: string): void {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      saveRename(id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      renamingId = null;
    }
  }

  function confirmDelete(id: string): void {
    deletingId = null;
    onDeleteConversation(id);
    refreshConversations();
  }

  function handleHistoryKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      closeHistory();
    }
  }

  /** The rename field: focused with its text selected. */
  function renameBox(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  /** Time today, otherwise the date. */
  function formatDate(time: number): string {
    if (!time) return "";
    const date = new Date(time);
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString();
  }
  let messages = $state<ChatMessage[]>([]);
  let inputText = $state("");
  let inputEnabled = $state(true);
  let placeholder = $state("Ask anything...");
  let messagesEl: HTMLElement | undefined = $state();
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let fileInputEl: HTMLInputElement | undefined = $state();
  let attachments = $state<ImageAttachment[]>([]);
  let inputFocused = $state(false);
  /** Typing: the attach button folds away so the text gets the width. */
  const typing = $derived(inputFocused && inputText.trim() !== "");
  let nextId = 0;
  /** A turn is running (set by the view); regenerate waits for it. */
  let busy = $state(false);

  // Editing a user message in place
  let editingId = $state<number | null>(null);
  let editText = $state("");

  /** The last answer (no user turn after it): the one that can be regenerated. */
  const lastAnswerId = $derived.by(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === "assistant") return msg.id;
      if (msg.type === "user" && msg.turnId) return -1;
    }
    return -1;
  });

  // Selection scope (shown as a pill above input)
  let selection = $state<SelectionScope | null>(null);

  // ask_user support
  let askUserResolve: ((value: string) => void) | null = $state(null);

  /** The action slot shows voice while there is nothing to send (not while a question waits for its answer). */
  const showVoiceStart = $derived(
    canVoice && !voice && !askUserResolve && inputText.trim() === "" && attachments.length === 0,
  );


  /** ChatGPT usage settings (OpenAI's guidelines for "Sign in with ChatGPT"). */
  function openUsage(): void {
    window.open(USAGE_URL, "_blank");
  }

  // ─── Scrolling: the latest question stays at the top ──────────────────
  // When a question is added, it is scrolled to the top of the message
  // area and the answer reads downward from it (like chat apps). Temporary
  // bottom padding (the "tail") makes that position reachable while the
  // content below is still short; it shrinks as the answer grows. Once the
  // user scrolls by hand, the position is left alone until the next question.
  // Adapted from scrollToLastQuestion() in nagisa525/obsidian-chatting-plus (MIT).
  const MESSAGES_PADDING = 12; // matches .chatting-minus-messages padding
  let messageListEl: HTMLElement | undefined = $state();
  let anchoredQuestionId = -1;
  let followQuestion = false;
  let scrollTail = 0;

  // A new question starts a new turn.
  $effect(() => {
    let lastQuestionId = -1;
    for (const msg of messages) if (msg.type === "user") lastQuestionId = msg.id;
    if (lastQuestionId !== anchoredQuestionId) {
      anchoredQuestionId = lastQuestionId;
      followQuestion = true;
    }
    keepQuestionInView();
  });

  // Rendered Markdown, math, images and a resized panel or phone keyboard
  // change heights after the messages do.
  $effect(() => {
    const el = messagesEl;
    if (!el || !messageListEl) return;
    const observer = new ResizeObserver(() => keepQuestionInView());
    observer.observe(el, { box: "border-box" });
    observer.observe(messageListEl);
    const stopFollowing = () => {
      followQuestion = false;
    };
    const stopOnScrollbar = (e: PointerEvent) => {
      if (e.target === el) stopFollowing();
    };
    const stopOnScrollKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) stopFollowing();
    };
    el.addEventListener("wheel", stopFollowing, { passive: true });
    el.addEventListener("touchmove", stopFollowing, { passive: true });
    el.addEventListener("pointerdown", stopOnScrollbar);
    el.addEventListener("keydown", stopOnScrollKey);
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", stopFollowing);
      el.removeEventListener("touchmove", stopFollowing);
      el.removeEventListener("pointerdown", stopOnScrollbar);
      el.removeEventListener("keydown", stopOnScrollKey);
    };
  });

  function keepQuestionInView(): void {
    const el = messagesEl;
    if (!el || !messageListEl) return;
    const questions = el.querySelectorAll<HTMLElement>(".chatting-minus-user-msg");
    const question = questions.item(questions.length - 1);
    let tail = 0;
    let target = 0;
    if (question) {
      // Positions in scroll coordinates; scrollHeight can't be used because
      // it never drops below the visible height.
      const top = el.getBoundingClientRect().top - el.scrollTop;
      target = Math.max(0, Math.round(question.getBoundingClientRect().top - top - MESSAGES_PADDING));
      const contentHeight = messageListEl.getBoundingClientRect().bottom - top + MESSAGES_PADDING;
      if (target > 0) tail = Math.max(0, Math.ceil(target - (contentHeight - el.clientHeight)));
    }
    if (tail !== scrollTail) {
      scrollTail = tail;
      el.style.setProperty("--chatting-minus-scroll-tail", `${tail}px`);
    }
    if (question && followQuestion) el.scrollTop = target;
  }

  // ─── Public API (called from chat-view.ts) ────────────────────────────

  export function addUserMessage(
    text: string,
    images: ImageAttachment[] = [],
    turnId?: string,
    selection?: SelectionScope,
  ): void {
    messages.push({ id: nextId++, type: "user", text, images: images.slice(), turnId, selection });
  }

  export function addAssistantMessage(text: string, streaming = false): number {
    const id = nextId++;
    messages.push({ id, type: "assistant", text, streaming });
    return id;
  }

  // ─── Streamed answers: Markdown is re-rendered at most every 100 ms ────
  const STREAM_RENDER_MS = 100;
  const pendingText = new Map<number, string>();
  let renderTimer: number | null = null;
  onDestroy(() => {
    if (renderTimer !== null) window.clearTimeout(renderTimer);
  });

  /** Replace an assistant message's text; `final` renders it at once. */
  export function updateAssistantMessage(id: number, text: string, final = false): void {
    pendingText.set(id, text);
    if (final) {
      flushPendingText();
      const msg = messages.find((m) => m.id === id);
      if (msg) msg.streaming = false;
    } else {
      renderTimer ??= window.setTimeout(flushPendingText, STREAM_RENDER_MS);
    }
  }

  function flushPendingText(): void {
    if (renderTimer !== null) window.clearTimeout(renderTimer);
    renderTimer = null;
    for (const [id, text] of pendingText) {
      const msg = messages.find((m) => m.id === id);
      if (msg) msg.text = text;
    }
    pendingText.clear();
  }

  export function removeMessage(id: number): void {
    pendingText.delete(id);
    const idx = messages.findIndex((m) => m.id === id);
    if (idx !== -1) messages.splice(idx, 1);
  }

  /** Remove the turn `turnId` and everything after it (edit, regenerate). */
  export function cutMessages(turnId: string): void {
    const idx = messages.findIndex((m) => m.type === "user" && m.turnId === turnId);
    if (idx === -1) return;
    for (const msg of messages.slice(idx)) pendingText.delete(msg.id);
    messages.splice(idx);
    editingId = null;
  }

  export function addToolCall(name: string, input: Record<string, unknown>): number {
    const id = nextId++;
    messages.push({ id, type: "tool-call", toolName: name, toolInput: input });
    return id;
  }

  export function updateToolResult(msgId: number, name: string, result: ToolResult): void {
    const msg = messages.find((m) => m.id === msgId);
    if (msg) {
      msg.type = "tool-result";
      msg.toolName = name;
      msg.toolResult = result;
    }
  }

  /** The thinking dots, with a short label next to them (e.g. "Resuming…"). */
  export function showThinking(label = ""): void {
    const shown = messages.find((m) => m.type === "thinking");
    if (shown) shown.text = label;
    else messages.push({ id: nextId++, type: "thinking", text: label });
  }

  export function hideThinking(): void {
    const idx = messages.findIndex((m) => m.type === "thinking");
    if (idx !== -1) messages.splice(idx, 1);
  }

  export function addError(text: string, kind?: ChatErrorKind): void {
    messages.push({ id: nextId++, type: "error", text, ...(kind ? { errorKind: kind } : {}) });
  }

  /** The next input answers an `ask_user` question (the view shows the question). */
  export function showAskUser(): Promise<string> {
    placeholder = "Type your answer...";
    inputEnabled = true;
    textareaEl?.focus();

    return new Promise<string>((resolve) => {
      askUserResolve = resolve;
    });
  }

  export function setInputEnabled(enabled: boolean): void {
    inputEnabled = enabled;
    placeholder = enabled ? "Ask anything..." : "Waiting for response...";
  }

  export function setBusy(value: boolean): void {
    busy = value;
  }

  /** Drop a pending `ask_user` question (its turn was stopped). */
  export function cancelAskUser(): void {
    const resolve = askUserResolve;
    askUserResolve = null;
    resolve?.("");
  }

  export function clearMessages(): void {
    pendingText.clear();
    messages = [];
    editingId = null;
    attachments = [];
    if (fileInputEl) fileInputEl.value = "";
    selection = null;
    hideThinking();
  }

  export function focus(): void {
    textareaEl?.focus();
  }

  /** Update the model display name in the header, and the provider (ChatGPT plan line) */
  export function setModel(name: string, newProvider: string): void {
    displayModel = name;
    displayProvider = newProvider;
  }

  /** Update the conversation title in the header */
  export function setTitle(value: string): void {
    displayTitle = value;
  }

  /** Set the selection scope (shows pill in UI) */
  export function setSelection(sel: SelectionScope): void {
    selection = sel;
  }

  /** Get the current selection scope */
  export function getSelection(): SelectionScope | null {
    return selection;
  }


  // ─── Internal handlers ────────────────────────────────────────────────

  function handleSend(): void {
    const text = inputText.trim();
    if (!text && attachments.length === 0) return;

    if (askUserResolve && attachments.length > 0) {
      new Notice("Image attachments are not supported when answering a tool question.");
      return;
    }

    inputText = "";
    resetHeight();
    const sentImages = attachments.slice();
    attachments = [];

    if (askUserResolve) {
      // The view shows the answer and keeps it in the history.
      const resolve = askUserResolve;
      askUserResolve = null;
      resolve(text);
      return;
    }

    // Pass current selection and consume it (one-shot per send)
    const currentSelection = selection;
    selection = null;
    onSend(text, currentSelection, sentImages);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function startEdit(msg: ChatMessage): void {
    editingId = msg.id;
    editText = msg.text ?? "";
  }

  function saveEdit(msg: ChatMessage): void {
    const text = editText.trim();
    if (!msg.turnId || (!text && !msg.images?.length)) return;
    editingId = null;
    onEdit(msg.turnId, text);
  }

  function handleEditKeydown(e: KeyboardEvent, msg: ChatMessage): void {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveEdit(msg);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      editingId = null;
    }
  }

  /** Fits a text box's height to its text, up to 300 px; a scrollbar only beyond that. */
  function fitHeight(node: HTMLTextAreaElement): void {
    node.style.setProperty("--chatting-minus-text-height", "auto");
    node.style.setProperty("--chatting-minus-text-height", `${Math.min(node.scrollHeight, 300)}px`);
    node.classList.toggle("is-scrollable", node.scrollHeight > 300);
  }

  /** The edit box: focused with the cursor at the end, grows with its text. */
  function editBox(node: HTMLTextAreaElement) {
    const grow = () => fitHeight(node);
    node.addEventListener("input", grow);
    grow();
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    return {
      destroy() {
        node.removeEventListener("input", grow);
      },
    };
  }

  function autoGrow(): void {
    if (textareaEl) fitHeight(textareaEl);
  }

  function resetHeight(): void {
    if (!textareaEl) return;
    textareaEl.style.setProperty("--chatting-minus-text-height", "auto");
    textareaEl.classList.remove("is-scrollable");
  }

  function imageDataUrl(image: ImageAttachment): string {
    return `data:${image.mediaType};base64,${image.data}`;
  }

  function openImagePicker(): void {
    if (inputEnabled) fileInputEl?.click();
  }

  async function handleImageSelection(event: Event): Promise<void> {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const files = Array.from(input.files ?? []);
    input.value = "";
    await addImageFiles(files);
  }

  function handlePaste(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    void addImageFiles(files);
  }

  async function addImageFiles(files: File[]): Promise<void> {
    for (const file of files) {
      if (attachments.length >= MAX_IMAGE_COUNT) {
        new Notice(`Attach up to ${MAX_IMAGE_COUNT} images per message.`);
        return;
      }

      try {
        const image = await readImageAttachment(file);
        const currentBytes = attachments.reduce((total, item) => total + item.sizeBytes, 0);
        if (currentBytes + image.sizeBytes > MAX_TOTAL_IMAGE_BYTES) {
          new Notice("The combined image size must be 12 MB or less per message.");
          return;
        }
        attachments = [...attachments, image];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Could not attach ${file.name || "image"}: ${message}`);
      }
    }
  }

  async function readImageAttachment(file: File): Promise<ImageAttachment> {
    let mediaType = file.type.toLowerCase() || inferImageMimeType(file.name);
    const isHeic = mediaType === "image/heic" || mediaType === "image/heif" ||
      /\.(heic|heif)$/i.test(file.name);
    let source: Blob = file;

    if (mediaType === "image/svg+xml") {
      throw new Error("SVG images are not supported. Choose a raster image instead.");
    }
    if (!mediaType.startsWith("image/")) {
      throw new Error("Choose an image file.");
    }

    if (isHeic || !SUPPORTED_IMAGE_TYPES.has(mediaType) || file.size > MAX_IMAGE_BYTES) {
      if (mediaType === "image/gif") {
        throw new Error("GIF files must be 5 MB or smaller.");
      }
      try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Image conversion is unavailable.");
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        mediaType = mediaType === "image/png" ? "image/png" : "image/jpeg";
        source = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (blob) => blob ? resolve(blob) : reject(new Error("Image conversion failed.")),
            mediaType,
            0.85,
          );
        });
      } catch {
        throw new Error("This image could not be converted. Try JPEG or PNG instead.");
      }
    }

    if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      throw new Error("Use a JPEG, PNG, GIF, or WebP image.");
    }
    if (source.size > MAX_IMAGE_BYTES) {
      throw new Error("Images must be 5 MB or smaller after conversion.");
    }

    const dataUrl = await readAsDataUrl(source);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("Image could not be read.");
    return {
      id: `image-${Date.now()}-${nextId++}`,
      fileName: file.name || `image.${mediaType.split("/")[1]}`,
      mediaType,
      data: dataUrl.slice(comma + 1),
      sizeBytes: source.size,
    };
  }

  function inferImageMimeType(fileName: string): string {
    const extension = fileName.split(".").pop()?.toLowerCase();
    const types: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      heic: "image/heic",
      heif: "image/heif",
    };
    return extension ? types[extension] ?? "" : "";
  }

  function readAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Image could not be read."));
      reader.onerror = () => reject(new Error("Image could not be read."));
      reader.readAsDataURL(blob);
    });
  }

  function removeAttachment(id: string): void {
    attachments = attachments.filter((image) => image.id !== id);
  }

  // Render markdown into a DOM node using Obsidian's renderer. Math
  // delimiters are normalized for display only; the message stays unchanged.
  // Each render gets its own child component, unloaded when the text changes
  // (streamed answers render many times) or the message goes away.
  function markdown(node: HTMLElement, text: string) {
    let child: Component | null = null;
    const render = (value: string) => {
      if (child) component.removeChild(child);
      child = component.addChild(new Component());
      node.empty();
      void MarkdownRenderer.render(app, normalizeMathMarkdown(value), node, "", child);
    };
    render(text);
    return {
      update: render,
      destroy() {
        if (child) component.removeChild(child);
      },
    };
  }

  function formatToolName(name: string): string {
    return name.replace(/_/g, " ");
  }

  function truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    return str.substring(0, max) + "\n... (truncated)";
  }
</script>

<!-- A user message's images; one no longer saved shows as a chip with its name. -->
{#snippet userImages(images: ImageAttachment[])}
  <div class="chatting-minus-user-images">
    {#each images as image (image.id)}
      {#if image.data}
        <img src={imageDataUrl(image)} alt={image.fileName} />
      {:else}
        <span class="chatting-minus-image-chip" title="Image no longer saved">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
          <span>{image.fileName}</span>
        </span>
      {/if}
    {/each}
  </div>
{/snippet}

<div class="chatting-minus-container">
  <!-- Header -->
  <div class="chatting-minus-header">
    <button
      class="chatting-minus-icon-btn"
      class:is-active={historyOpen}
      type="button"
      onclick={toggleHistory}
      aria-label="Chats"
      aria-expanded={historyOpen}
      title="Chats"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l4 2"></path></svg>
    </button>
    <div class="chatting-minus-header-left">
      <span class="chatting-minus-header-title" title={displayTitle}>{displayTitle || "New chat"}</span>
      <span class="chatting-minus-header-model">{displayModel || "No model"}</span>
    </div>
    <button class="chatting-minus-clear-btn" type="button" onclick={onClear}>Clear</button>
    <button
      class="chatting-minus-icon-btn"
      type="button"
      onclick={newChat}
      aria-label="New chat"
      title="New chat"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"></path></svg>
    </button>
  </div>

  <div class="chatting-minus-body">
  {#if historyOpen}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="chatting-minus-history" role="dialog" aria-label="Chats" tabindex="-1" onkeydown={handleHistoryKeydown}>
      <div class="chatting-minus-history-head">
        <span class="chatting-minus-history-heading">Chats</span>
        <button type="button" class="mod-cta" onclick={newChat}>New chat</button>
      </div>
      {#if conversations.length === 0}
        <div class="chatting-minus-history-empty">No saved chats yet.</div>
      {/if}
      <ul class="chatting-minus-history-list">
        {#each conversations as conversation (conversation.id)}
          <li class="chatting-minus-history-row" class:is-active={conversation.active}>
            {#if renamingId === conversation.id}
              <input
                class="chatting-minus-history-rename"
                type="text"
                bind:value={renameText}
                use:renameBox
                aria-label="Chat name"
                onkeydown={(e) => handleRenameKeydown(e, conversation.id)}
                onblur={() => saveRename(conversation.id)}
              />
            {:else if deletingId === conversation.id}
              <span class="chatting-minus-history-confirm">Delete “{conversation.title}”?</span>
              <button type="button" onclick={() => deletingId = null}>Cancel</button>
              <button type="button" class="mod-warning" onclick={() => confirmDelete(conversation.id)}>Delete</button>
            {:else}
              <button
                class="chatting-minus-history-open"
                type="button"
                onclick={() => openConversation(conversation.id)}
                aria-current={conversation.active ? "true" : undefined}
              >
                <span class="chatting-minus-history-title">{conversation.title}</span>
                <span class="chatting-minus-history-date">{formatDate(conversation.updatedAt)}</span>
              </button>
              <button
                class="chatting-minus-icon-btn"
                type="button"
                onclick={() => startRename(conversation)}
                aria-label={`Rename ${conversation.title}`}
                title="Rename"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
              </button>
              <button
                class="chatting-minus-icon-btn"
                type="button"
                onclick={() => { renamingId = null; deletingId = conversation.id; }}
                aria-label={`Delete ${conversation.title}`}
                title="Delete"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- Messages -->
  <div class="chatting-minus-messages" bind:this={messagesEl}>
    <div class="chatting-minus-message-list" bind:this={messageListEl}>
    {#each messages as msg (msg.id)}
      {#if msg.type === "user"}
        <div class="chatting-minus-user-turn" class:chatting-minus-editing={editingId === msg.id}>
          {#if editingId === msg.id}
            <div class="chatting-minus-msg chatting-minus-user-msg chatting-minus-user-edit">
              {#if msg.images?.length}
                {@render userImages(msg.images)}
              {/if}
              {#if msg.images?.some((image) => !image.data)}
                <div class="chatting-minus-edit-note">Images no longer saved are left out.</div>
              {/if}
              {#if msg.selection}
                <div class="chatting-minus-edit-note">Selection from {msg.selection.filePath.split("/").pop()}</div>
              {/if}
              <textarea
                class="chatting-minus-edit-input"
                bind:value={editText}
                use:editBox
                rows="1"
                aria-label="Edit message"
                onkeydown={(e) => handleEditKeydown(e, msg)}
              ></textarea>
              <div class="chatting-minus-edit-note">Changes the AI already made to notes stay.</div>
              <div class="chatting-minus-edit-buttons">
                <button type="button" onclick={() => editingId = null}>Cancel</button>
                <button type="button" class="mod-cta" onclick={() => saveEdit(msg)}>Save</button>
              </div>
            </div>
          {:else}
            <div class="chatting-minus-msg chatting-minus-user-msg">
              {#if msg.images?.length}
                {@render userImages(msg.images)}
              {/if}
              {#if msg.text}
                <div class="chatting-minus-msg-content">{msg.text}</div>
              {/if}
            </div>
            {#if msg.turnId}
              <div class="chatting-minus-msg-actions chatting-minus-hover-actions">
                <button
                  class="chatting-minus-action-btn"
                  type="button"
                  onclick={() => startEdit(msg)}
                  aria-label="Edit message"
                  title="Edit"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
                </button>
              </div>
            {/if}
          {/if}
        </div>

      {:else if msg.type === "assistant"}
        <div class="chatting-minus-answer">
          <div class="chatting-minus-msg chatting-minus-assistant-msg">
            <div class="chatting-minus-msg-content" use:markdown={msg.text ?? ""}></div>
          </div>
          {#if !msg.streaming}
            <div class="chatting-minus-msg-actions" class:chatting-minus-hover-actions={msg.id !== lastAnswerId}>
              <button
                class="chatting-minus-action-btn"
                type="button"
                onclick={() => onCopy(msg.text ?? "")}
                aria-label="Copy answer"
                title="Copy"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
              {#if msg.id === lastAnswerId && !busy}
                <button
                  class="chatting-minus-action-btn"
                  type="button"
                  onclick={onRegenerate}
                  aria-label="Regenerate answer"
                  title="Regenerate"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"></path><polyline points="21 3 21 8 16 8"></polyline></svg>
                </button>
              {/if}
            </div>
          {/if}
        </div>

      {:else if msg.type === "tool-call"}
        <div class="chatting-minus-tool-call">
          <div class="chatting-minus-tool-status">
            <span class="chatting-minus-spinner"></span>
            <span class="chatting-minus-tool-name">{formatToolName(msg.toolName ?? "")}</span>
          </div>
          <details class="chatting-minus-tool-details">
            <summary>Parameters</summary>
            <pre class="chatting-minus-tool-json">{JSON.stringify(msg.toolInput, null, 2)}</pre>
          </details>
        </div>

      {:else if msg.type === "tool-result"}
        <div class="chatting-minus-tool-call">
          <div class="chatting-minus-tool-status">
            <span class={msg.toolResult?.isError ? "chatting-minus-tool-error" : "chatting-minus-tool-success"}>
              {msg.toolResult?.isError ? "\u2718" : "\u2714"}
            </span>
            <span class="chatting-minus-tool-name">{formatToolName(msg.toolName ?? "")}</span>
          </div>
          {#if msg.toolInput && Object.keys(msg.toolInput).length > 0}
            <details class="chatting-minus-tool-details">
              <summary>Parameters</summary>
              <pre class="chatting-minus-tool-json">{JSON.stringify(msg.toolInput, null, 2)}</pre>
            </details>
          {/if}
          <details class="chatting-minus-tool-details">
            <summary>{msg.toolResult?.isError ? "Error" : "Result"}</summary>
            <pre class="chatting-minus-tool-json">{truncate(msg.toolResult?.result ?? "", 2000)}</pre>
          </details>
        </div>

      {:else if msg.type === "error" && msg.errorKind === "usage-limit"}
        <div class="chatting-minus-msg chatting-minus-usage-limit" role="alert">
          <div class="chatting-minus-usage-limit-brand">ChatGPT</div>
          <div class="chatting-minus-usage-limit-title">Usage limit reached</div>
          <p>You've reached the usage limit of your ChatGPT plan or of this plugin. Review it in ChatGPT settings.</p>
          <button class="mod-cta" type="button" onclick={openUsage}>Manage usage</button>
          <div class="chatting-minus-usage-limit-detail">{msg.text}</div>
        </div>

      {:else if msg.type === "error"}
        <div class="chatting-minus-msg chatting-minus-error-msg">
          <div class="chatting-minus-msg-content">{msg.text}</div>
        </div>

      {:else if msg.type === "thinking"}
        <div class="chatting-minus-thinking">
          <span class="chatting-minus-dot"></span>
          <span class="chatting-minus-dot"></span>
          <span class="chatting-minus-dot"></span>
          {#if msg.text}<span class="chatting-minus-thinking-label" aria-live="polite">{msg.text}</span>{/if}
        </div>
      {/if}
    {/each}
    </div>
  </div>

  <!-- Selection pill -->
  {#if selection}
    <div class="chatting-minus-selection-pill">
      <div class="chatting-minus-selection-content">
        <span class="chatting-minus-selection-label">Selection from {selection.filePath.split("/").pop()}</span>
        <span class="chatting-minus-selection-preview">{selection.text.substring(0, 80)}{selection.text.length > 80 ? "..." : ""}</span>
      </div>
      <button
        class="chatting-minus-selection-dismiss"
        onclick={() => selection = null}
        aria-label="Remove selection"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  {/if}

  {#if attachments.length > 0}
    <div class="chatting-minus-attachment-tray" aria-label="Image attachments">
      {#each attachments as image (image.id)}
        <div class="chatting-minus-attachment-preview">
          <img src={imageDataUrl(image)} alt={image.fileName} />
          <span title={image.fileName}>{image.fileName}</span>
          <button
            class="chatting-minus-attachment-remove"
            type="button"
            onclick={() => removeAttachment(image.id)}
            disabled={!inputEnabled}
            aria-label={`Remove ${image.fileName}`}
          >×</button>
        </div>
      {/each}
    </div>
  {/if}

  {#if displayProvider === "chatgpt-oauth"}
    <div class="chatting-minus-plan-row">
      <span>Using ChatGPT plan</span>
      <button class="chatting-minus-link-btn" type="button" onclick={openUsage}>Manage usage</button>
    </div>
  {/if}

  {#if voice}
    <div class="chatting-minus-voice-bar" role="region" aria-label="Voice conversation">
      <div class="chatting-minus-voice-header">
        <span class="chatting-minus-voice-dot" data-status={voice.status} aria-hidden="true"></span>
        <span class="chatting-minus-voice-status" aria-live="polite">{VOICE_STATUS[voice.status]}{voice.micOn ? "" : " · mic off"}</span>
      </div>
      {#if voice.you || voice.assistant}
        <div class="chatting-minus-voice-captions">
          {#if voice.you}<p><span class="chatting-minus-voice-who">You</span> {captionTail(voice.you)}</p>{/if}
          {#if voice.assistant}<p><span class="chatting-minus-voice-who">Voice</span> {captionTail(voice.assistant)}</p>{/if}
        </div>
      {/if}
      <div class="chatting-minus-voice-controls">
        {#if voice.audioBlocked}
          <button class="chatting-minus-voice-btn mod-cta" type="button" onclick={() => onVoice("play")}>Tap to play audio</button>
        {/if}
        {#if voice.holdToTalk}
          <button
            class="chatting-minus-voice-btn chatting-minus-voice-talk"
            class:is-active={voice.micOn}
            type="button"
            aria-pressed={voice.micOn}
            disabled={voice.status === "connecting"}
            onpointerdown={talkStart}
            onpointerup={() => onVoice("talk-end")}
            onpointercancel={() => onVoice("talk-end")}
            onkeydown={(event) => talkKey(event, true)}
            onkeyup={(event) => talkKey(event, false)}
            oncontextmenu={(event) => event.preventDefault()}
          >{voice.micOn ? "Talking…" : "Hold to talk"}</button>
        {:else}
          <button
            class="chatting-minus-voice-btn"
            type="button"
            aria-pressed={!voice.micOn}
            disabled={voice.status === "connecting"}
            onclick={() => onVoice("mute")}
          >{voice.micOn ? "Mute" : "Unmute"}</button>
        {/if}
        <button class="chatting-minus-voice-btn chatting-minus-voice-end" type="button" onclick={() => onVoice("end")}>End</button>
      </div>
    </div>
  {/if}

  <!-- Input bar -->
  <div class="chatting-minus-input-bar" class:has-plan-row={displayProvider === "chatgpt-oauth"}>
    <input
      bind:this={fileInputEl}
      class="chatting-minus-file-input"
      type="file"
      accept="image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif"
      multiple
      onchange={handleImageSelection}
      aria-label="Choose images"
    />
    <!-- While typing, the attach button folds away so the text gets the width -->
    {#if !typing}
      <button
        class="chatting-minus-attach-btn"
        type="button"
        onclick={openImagePicker}
        disabled={!inputEnabled || attachments.length >= MAX_IMAGE_COUNT}
        aria-label="Attach images"
        title="Attach images"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
      </button>
    {/if}
    <textarea
      class="chatting-minus-input"
      bind:this={textareaEl}
      bind:value={inputText}
      {placeholder}
      disabled={!inputEnabled}
      rows="1"
      onkeydown={handleKeydown}
      onpaste={handlePaste}
      oninput={autoGrow}
      onfocus={() => { inputFocused = true; }}
      onblur={() => { inputFocused = false; }}
    ></textarea>
    <!-- One action slot, as in the chat apps: voice while there's nothing to send, else send; stop while a turn runs -->
    {#if inputEnabled && showVoiceStart}
      <button
        class="chatting-minus-attach-btn chatting-minus-voice-start"
        type="button"
        onclick={() => onVoice("start")}
        aria-label="Start voice conversation"
        title="Start voice conversation"
      >
        <!-- Live voice, as in the chat apps: a filled circle with sound-wave bars (the microphone means dictation there) -->
        <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="currentColor"></circle><g class="chatting-minus-voice-bars" fill="none" stroke-width="2" stroke-linecap="round"><line x1="7.5" y1="10.5" x2="7.5" y2="13.5"></line><line x1="10.5" y1="7.5" x2="10.5" y2="16.5"></line><line x1="13.5" y1="9" x2="13.5" y2="15"></line><line x1="16.5" y1="10.5" x2="16.5" y2="13.5"></line></g></svg>
      </button>
    {:else if inputEnabled}
      <button
        class="chatting-minus-send-btn"
        onclick={handleSend}
        aria-label="Send message"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
      </button>
    {:else}
      <button
        class="chatting-minus-send-btn chatting-minus-stop-btn"
        onclick={onStop}
        aria-label="Stop generation"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
      </button>
    {/if}
  </div>
  </div>
</div>

<style>
  /* ─── Container ─────────────────────────────────────────────────────── */
  .chatting-minus-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ─── Header ────────────────────────────────────────────────────────── */
  .chatting-minus-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  .chatting-minus-header-left {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .chatting-minus-header-title {
    font-weight: var(--font-weight-bold, 600);
    font-size: var(--font-ui-medium);
    color: var(--text-normal);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Header and history list icons; 32px for touch. */
  .chatting-minus-icon-btn {
    width: 32px;
    height: 32px;
    min-width: 32px;
    padding: 0;
    border: none;
    border-radius: var(--radius-s);
    background: transparent;
    box-shadow: none;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .chatting-minus-icon-btn:hover,
  .chatting-minus-icon-btn.is-active {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  /* ─── Body: chat, with the history list over it ─────────────────────── */
  .chatting-minus-body {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .chatting-minus-history {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    background: var(--background-primary);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px 8px calc(8px + env(safe-area-inset-bottom, 0px));
  }

  .chatting-minus-history:focus {
    outline: none;
  }

  .chatting-minus-history-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 4px 8px;
  }

  .chatting-minus-history-heading {
    font-weight: var(--font-weight-bold, 600);
    color: var(--text-normal);
  }

  .chatting-minus-history-empty {
    padding: 12px 4px;
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  .chatting-minus-history-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .chatting-minus-history-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 44px;
    padding: 0 4px;
    border-radius: var(--radius-m);
  }

  .chatting-minus-history-row.is-active {
    background: var(--background-modifier-hover);
  }

  .chatting-minus-history-open {
    flex: 1;
    min-width: 0;
    min-height: 40px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 1px;
    padding: 4px 6px;
    border: none;
    background: transparent;
    box-shadow: none;
    text-align: left;
    cursor: pointer;
    height: auto;
  }

  .chatting-minus-history-title {
    max-width: 100%;
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chatting-minus-history-date {
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }

  .chatting-minus-history-rename {
    flex: 1;
    min-width: 0;
    min-height: 36px;
  }

  .chatting-minus-history-confirm {
    flex: 1;
    min-width: 0;
    font-size: var(--font-ui-small);
    color: var(--text-normal);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chatting-minus-history-row button:not(.chatting-minus-icon-btn):not(.chatting-minus-history-open) {
    min-height: 32px;
  }

  .chatting-minus-header-model {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    /* Model name + thinking level can outgrow a phone-width panel */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chatting-minus-clear-btn {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    background: none;
    border: none;
    cursor: pointer;
    min-height: 32px;
    padding: 4px 8px;
    border-radius: var(--radius-s);
    box-shadow: none;
    flex-shrink: 0;
  }

  .chatting-minus-clear-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  /* ─── Messages ──────────────────────────────────────────────────────── */
  .chatting-minus-messages {
    flex: 1 1 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    /* The tail lets the latest question scroll to the top (see keepQuestionInView). */
    padding: 12px 12px calc(12px + var(--chatting-minus-scroll-tail, 0px));
    -webkit-user-select: text;
    user-select: text;
  }

  .chatting-minus-message-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .chatting-minus-msg {
    max-width: 90%;
    padding: 8px 12px;
    border-radius: var(--radius-m);
    line-height: 1.5;
    word-wrap: break-word;
    -webkit-user-select: text;
    user-select: text;
  }

  .chatting-minus-user-msg {
    align-self: flex-end;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-bottom-right-radius: var(--radius-s);
  }

  /* A user message with its edit action, or its edit box */
  .chatting-minus-user-turn {
    align-self: flex-end;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    max-width: 90%;
  }

  .chatting-minus-user-turn.chatting-minus-editing {
    width: 90%;
  }

  .chatting-minus-user-turn > .chatting-minus-msg,
  .chatting-minus-answer > .chatting-minus-msg {
    max-width: 100%;
  }

  .chatting-minus-user-edit {
    width: 100%;
    background: var(--background-secondary);
    color: var(--text-normal);
    border: 1px solid var(--interactive-accent);
    border-bottom-right-radius: var(--radius-m);
  }

  .chatting-minus-edit-input {
    width: 100%;
    resize: none;
    height: var(--chatting-minus-text-height, auto);
    max-height: 300px;
    padding: 6px 8px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    background: var(--background-primary);
    color: var(--text-normal);
    font-family: var(--font-interface);
    font-size: var(--font-ui-medium);
    line-height: 1.4;
  }

  .chatting-minus-edit-note {
    margin: 4px 0;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .chatting-minus-edit-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  /* An answer with its action row */
  .chatting-minus-answer {
    align-self: flex-start;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    max-width: 90%;
  }

  /* ─── Message actions (edit, copy, regenerate) ──────────────────────── */
  .chatting-minus-msg-actions {
    display: flex;
    gap: 2px;
    margin-top: 2px;
  }

  .chatting-minus-action-btn {
    width: 26px;
    height: 26px;
    padding: 0;
    border: none;
    border-radius: var(--radius-s);
    background: transparent;
    box-shadow: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .chatting-minus-action-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  /* With a mouse, these appear on hover; on touch screens they stay visible. */
  @media (hover: hover) and (pointer: fine) {
    .chatting-minus-hover-actions {
      opacity: 0;
      transition: opacity 0.15s;
    }

    .chatting-minus-user-turn:hover .chatting-minus-hover-actions,
    .chatting-minus-answer:hover .chatting-minus-hover-actions,
    .chatting-minus-hover-actions:focus-within {
      opacity: 1;
    }
  }

  @media (hover: none) {
    .chatting-minus-action-btn {
      width: 32px;
      height: 32px;
    }
  }

  .chatting-minus-user-images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }

  .chatting-minus-user-images img {
    max-width: min(100%, 280px);
    max-height: 220px;
    border-radius: var(--radius-s);
    object-fit: contain;
  }

  .chatting-minus-image-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 8px;
    border-radius: var(--radius-s);
    background: rgba(0, 0, 0, 0.15);
    font-size: var(--font-ui-smaller);
  }

  .chatting-minus-image-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chatting-minus-assistant-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-normal);
    border-bottom-left-radius: var(--radius-s);
  }

  .chatting-minus-assistant-msg :global(p:first-child) {
    margin-top: 0;
  }

  .chatting-minus-assistant-msg :global(p:last-child) {
    margin-bottom: 0;
  }

  .chatting-minus-error-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-error);
    border-left: 3px solid var(--text-error);
    font-size: var(--font-ui-smaller);
    max-width: 90%;
  }

  /* Usage limit: the ChatGPT identity stays visible; Manage usage is the main action */
  .chatting-minus-usage-limit {
    align-self: flex-start;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    max-width: 90%;
  }

  .chatting-minus-usage-limit p {
    margin: 0;
  }

  .chatting-minus-usage-limit-brand,
  .chatting-minus-usage-limit-detail {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .chatting-minus-usage-limit-title {
    font-weight: var(--font-semibold);
  }

  /* ─── ChatGPT plan line above the input ───────────────────────────── */
  .chatting-minus-plan-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 12px 0;
    border-top: 1px solid var(--background-modifier-border);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .chatting-minus-link-btn {
    background: none;
    border: none;
    box-shadow: none;
    padding: 0;
    height: auto;
    font-size: inherit;
    color: var(--text-accent);
    cursor: pointer;
  }

  .chatting-minus-input-bar.has-plan-row {
    border-top: none;
  }

  /* ─── Tool Calls ────────────────────────────────────────────────────── */
  .chatting-minus-tool-call {
    align-self: flex-start;
    padding: 6px 10px;
    background: var(--background-secondary-alt);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    max-width: 90%;
  }

  .chatting-minus-tool-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .chatting-minus-tool-name {
    font-weight: 500;
  }

  .chatting-minus-tool-success {
    color: var(--text-success);
  }

  .chatting-minus-tool-error {
    color: var(--text-error);
  }

  .chatting-minus-tool-details {
    margin-top: 4px;
  }

  .chatting-minus-tool-details summary {
    cursor: pointer;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }

  .chatting-minus-tool-json {
    margin: 4px 0 0;
    padding: 6px 8px;
    background: var(--background-primary);
    border-radius: var(--radius-s);
    font-size: 11px;
    max-height: 150px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ─── Spinner ───────────────────────────────────────────────────────── */
  .chatting-minus-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--text-faint);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: chatting-minus-spin 0.6s linear infinite;
  }

  @keyframes chatting-minus-spin {
    to { transform: rotate(360deg); }
  }

  /* ─── Thinking Dots ─────────────────────────────────────────────────── */
  .chatting-minus-thinking {
    align-self: flex-start;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 12px;
  }

  .chatting-minus-thinking-label {
    margin-left: 4px;
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  .chatting-minus-dot {
    width: 8px;
    height: 8px;
    background: var(--text-faint);
    border-radius: 50%;
    animation: chatting-minus-pulse 1.4s ease-in-out infinite;
  }

  .chatting-minus-dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .chatting-minus-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes chatting-minus-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  /* ─── Input Bar ─────────────────────────────────────────────────────── */
  .chatting-minus-file-input {
    display: none;
  }

  .chatting-minus-attachment-tray {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 8px 12px 0;
    flex-shrink: 0;
  }

  .chatting-minus-attachment-preview {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 190px;
    min-width: 190px;
    padding: 5px 28px 5px 5px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    background: var(--background-secondary);
  }

  .chatting-minus-attachment-preview img {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: 4px;
    object-fit: cover;
  }

  .chatting-minus-attachment-preview span {
    min-width: 0;
    overflow: hidden;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chatting-minus-attachment-remove {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--background-modifier-hover);
    color: var(--text-muted);
    cursor: pointer;
  }

  .chatting-minus-attachment-remove:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .chatting-minus-input-bar {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 12px;
    padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--background-modifier-border);
    background: transparent;
    flex-shrink: 0;
  }

  /* Live voice: a solid circle (text colour) with bars in the background colour */
  .chatting-minus-voice-start {
    color: var(--text-normal);
  }

  .chatting-minus-voice-bars {
    stroke: var(--background-primary);
  }

  .chatting-minus-attach-btn {
    width: 34px;
    height: 34px;
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .chatting-minus-attach-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .chatting-minus-attach-btn:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .chatting-minus-input {
    flex: 1;
    resize: none;
    border: 1.5px solid var(--background-modifier-border-hover, var(--background-modifier-border));
    border-radius: 20px;
    padding: 8px 16px;
    font-size: var(--font-ui-medium);
    font-family: var(--font-interface);
    background-color: var(--background-secondary);
    color: var(--text-normal);
    line-height: 1.4;
    height: var(--chatting-minus-text-height, auto);
    max-height: 300px;
    /* fitHeight() turns the scrollbar on only beyond the maximum height */
    overflow-y: hidden;
    box-shadow: none;
  }

  /* Set by fitHeight(), outside the template. */
  .chatting-minus-input:global(.is-scrollable) {
    overflow-y: auto;
  }

  .chatting-minus-input:focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: none;
  }

  .chatting-minus-input:disabled {
    opacity: 0.5;
  }

  .chatting-minus-send-btn {
    width: 34px;
    height: 34px;
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background-color: var(--interactive-accent);
    color: var(--text-on-accent);
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: none;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 1px;
  }

  .chatting-minus-send-btn:hover {
    background-color: var(--interactive-accent-hover);
  }

  .chatting-minus-send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .chatting-minus-stop-btn {
    background-color: var(--text-error);
  }

  .chatting-minus-stop-btn:hover {
    background-color: var(--text-error);
    opacity: 0.85;
  }

  /* ─── Voice bar ──────────────────────────────────────────────────────── */
  .chatting-minus-voice-bar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 8px 0;
    padding: 8px 10px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    background: var(--background-secondary);
    flex-shrink: 0;
  }

  .chatting-minus-voice-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-ui-small);
    color: var(--text-muted);
  }

  .chatting-minus-voice-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-faint);
    flex-shrink: 0;
  }

  .chatting-minus-voice-dot[data-status="listening"] {
    background: var(--color-green, var(--interactive-accent));
  }

  .chatting-minus-voice-dot[data-status="speaking"] {
    background: var(--interactive-accent);
    animation: chatting-minus-voice-pulse 1s ease-in-out infinite;
  }

  .chatting-minus-voice-dot[data-status="thinking"],
  .chatting-minus-voice-dot[data-status="connecting"] {
    background: var(--color-yellow, var(--text-muted));
    animation: chatting-minus-voice-pulse 1.4s ease-in-out infinite;
  }

  @keyframes chatting-minus-voice-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .chatting-minus-voice-captions {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--font-ui-small);
    color: var(--text-normal);
    overflow-wrap: anywhere;
  }

  .chatting-minus-voice-captions p {
    margin: 0;
  }

  .chatting-minus-voice-who {
    color: var(--text-muted);
    font-weight: 600;
    margin-right: 4px;
  }

  .chatting-minus-voice-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .chatting-minus-voice-btn {
    min-height: 34px;
    padding: 0 14px;
    border-radius: var(--radius-m);
    cursor: pointer;
  }

  .chatting-minus-voice-talk {
    flex: 1;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }

  .chatting-minus-voice-talk.is-active {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .chatting-minus-voice-end {
    margin-left: auto;
    color: var(--text-error);
  }

  /* ─── Selection Pill ─────────────────────────────────────────────────── */
  .chatting-minus-selection-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 8px 0;
    padding: 6px 10px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    flex-shrink: 0;
  }

  .chatting-minus-selection-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .chatting-minus-selection-label {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    font-weight: 500;
  }

  .chatting-minus-selection-preview {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chatting-minus-selection-dismiss {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--background-modifier-hover);
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .chatting-minus-selection-dismiss:hover {
    background: var(--background-modifier-border);
    color: var(--text-normal);
  }

  /* ─── Responsive ────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    .chatting-minus-msg,
    .chatting-minus-user-turn,
    .chatting-minus-answer {
      max-width: 95%;
    }

    .chatting-minus-user-turn.chatting-minus-editing {
      width: 95%;
    }

    .chatting-minus-edit-input {
      font-size: 16px; /* Prevents iOS zoom on focus */
    }

    .chatting-minus-input-bar {
      gap: 10px;
      padding: 10px 12px;
      padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    }

    .chatting-minus-input {
      font-size: 16px; /* Prevents iOS zoom on focus */
      padding: 10px 16px;
      border-radius: 22px;
    }

    .chatting-minus-send-btn {
      width: 36px;
      height: 36px;
      min-width: 36px;
      min-height: 36px;
    }
  }
</style>
