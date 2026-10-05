/**
 * Runs a live voice conversation with client delegation (ADR-11): the
 * voice model talks; when it delegates, the request runs as a normal chat
 * turn through the chat view (any provider), and the answer goes back for
 * the voice to speak.
 */
import type { ChatHistoryEntry } from "../types";
import {
  VOICE_INSTRUCTIONS,
  eventDialect,
  parseVoiceEvent,
  progressEvents,
  seedItems,
  speakEvents,
  spokenAnswer,
  type VoiceDialect,
} from "./protocol";
import { VoiceCancelled, VoiceSession, type VoiceRoute } from "./session";

export type VoiceStatus = "connecting" | "reconnecting" | "listening" | "thinking" | "speaking";

/** What the voice bar shows. */
export interface VoiceViewState {
  status: VoiceStatus;
  /** The user's latest words (live caption). */
  you: string;
  /** The voice's latest words. */
  assistant: string;
  micOn: boolean;
  holdToTalk: boolean;
  /** Autoplay was blocked: show "Tap to play audio". */
  audioBlocked: boolean;
}

/** Calls from the chat view's turn function into the voice conversation. */
export interface VoiceTurnHooks {
  onToolCall(name: string): void;
  /** Answer text the loop delivered (text before tool calls, then the final answer). */
  onText(text: string): void;
  onAskUser(question: string): void;
  onError(message: string): void;
}

/** What the controller needs from the chat view. */
export interface VoiceHost {
  /** Run `text` as a chat turn, like a typed message; resolves when it has ended. */
  runTurn(text: string, hooks: VoiceTurnHooks): Promise<void>;
  /** Stop the running turn, like Stop. */
  stopTurn(): void;
  turnRunning(): boolean;
  history(): ChatHistoryEntry[];
  showError(message: string): void;
  /** Show the voice bar; null when the conversation has ended. */
  render(state: VoiceViewState | null): void;
  log(label: string, data: unknown): void;
}

/** Delays in ms; tests shorten them. */
export const VOICE_TIMING = {
  /** A delegation without task text waits until the user's words have stopped arriving this long… */
  quiet: 700,
  /** …but not longer than this. */
  maxWait: 2500,
  /** "Speaking" ends when no words of the voice arrived for this long. */
  speaking: 1500,
  /** Mobile (ADR-15): back after longer than this in the background, the call is replaced… */
  reconnectAfter: 20_000,
  /** …and after this long in the background it ends. */
  endAfter: 60_000,
};

export class VoiceController {
  private readonly session: VoiceSession;
  private dialect: VoiceDialect;
  private dialectKnown = false;
  private state: VoiceViewState;
  private ended = false;
  /** The user's words since the last delegation took them. */
  private pendingInput = "";
  private lastInputAt = 0;
  private lastSpeaker: "user" | "assistant" | null = null;
  /** Increases with each delegation; an older turn's answer isn't spoken. */
  private delegation = 0;
  private voiceTurnRunning = false;
  private speakingTimer?: number;
  /** Obsidian is in the background (mobile, ADR-15): microphone off, a lost call not reported. */
  private background = false;

  /**
   * `reconnecting`: this replaces a call lost in the background, shown as
   * "Reconnecting…"; `micOn`: hands-free, the old call's microphone state.
   */
  constructor(private readonly host: VoiceHost, route: VoiceRoute, holdToTalk: boolean,
    { reconnecting = false, micOn = true }: { reconnecting?: boolean; micOn?: boolean } = {}) {
    this.dialect = route.dialect;
    this.state = {
      status: reconnecting ? "reconnecting" : "connecting",
      you: "", assistant: "", micOn: !holdToTalk && micOn, holdToTalk, audioBlocked: false,
    };
    this.session = new VoiceSession(route, {
      onMessage: (message) => this.receive(message),
      onEnded: (error) => this.onEnded(error),
      onAudioBlocked: () => this.update({ audioBlocked: true }),
      log: (label, data) => host.log(label, data),
    });
  }

  /** Connect and start listening. Errors are shown in the chat. */
  async start(): Promise<void> {
    this.render();
    try {
      await this.session.start(VOICE_INSTRUCTIONS, seedItems(this.host.history()));
      if (this.ended) return;
      this.session.setMicEnabled(this.state.micOn && !this.background);
      this.update({ status: "listening" });
    } catch (error) {
      if (error instanceof VoiceCancelled || this.ended) return;
      this.ended = true;
      this.host.render(null);
      this.host.showError(error instanceof Error ? error.message : String(error));
    }
  }

  /** End the conversation. A running turn finishes in the chat but isn't spoken. */
  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    window.clearTimeout(this.speakingTimer);
    this.host.render(null);
    await this.session.end();
  }

  /** Hands-free: mute or unmute the microphone. */
  toggleMute(): void {
    this.setMic(!this.state.micOn);
  }

  /** Hold to talk: the microphone is on while the button is pressed. */
  setTalking(pressed: boolean): void {
    if (this.state.holdToTalk) this.setMic(pressed);
  }

  resumeAudio(): void {
    this.update({ audioBlocked: false });
    this.session.resumeAudio().catch(() => this.update({ audioBlocked: true }));
  }

  /** The microphone is on in the voice bar (hands-free and not muted, or held). */
  isMicOn(): boolean {
    return this.state.micOn;
  }

  /**
   * Mobile: Obsidian went to the background, where the microphone records
   * only silence. It is turned off, and a call that drops now isn't
   * reported: the view decides on the return (ADR-15).
   */
  enterBackground(): void {
    this.background = true;
    this.session.setMicEnabled(false);
  }

  /**
   * Back after `hiddenMs` in the background: true when the call still
   * works (the microphone as it was; off for hold to talk, whose press
   * ended), false when it must be replaced (lost, or away longer than
   * `reconnectAfter`).
   */
  leaveBackground(hiddenMs: number): boolean {
    this.background = false;
    if (this.ended || hiddenMs > VOICE_TIMING.reconnectAfter || !this.session.isConnected()) return false;
    this.setMic(this.state.micOn && !this.state.holdToTalk);
    return true;
  }

  private setMic(on: boolean): void {
    this.session.setMicEnabled(on);
    this.update({ micOn: on });
  }

  private receive(message: Record<string, unknown>): void {
    if (this.ended) return;
    const type = typeof message.type === "string" ? message.type : "";
    const dialect = eventDialect(type);
    if (dialect && !this.dialectKnown) {
      this.dialectKnown = true;
      if (dialect !== this.dialect) this.host.log("VOICE_DIALECT", { from: this.dialect, to: dialect });
      this.dialect = dialect;
    }
    const event = parseVoiceEvent(message);
    switch (event.kind) {
      case "input":
        this.pendingInput += event.text;
        this.lastInputAt = Date.now();
        this.caption("user", event.text);
        break;
      case "output":
        this.caption("assistant", event.text);
        break;
      case "turn-done":
        if (event.role === "user") this.update({ you: event.text });
        else this.update({ assistant: event.text });
        break;
      case "delegation":
        void this.delegate(event.id, event.text);
        break;
      case "error":
        this.host.showError(`Voice: ${event.message}`);
        break;
      case "closed":
        // The session ends after this event; say why unless we asked for it.
        // In the background the call is replaced on the return instead.
        if (event.reason && event.reason !== "close_requested" && !this.background) this.host.showError(`The voice conversation ended (${event.reason.replace(/_/g, " ")}).`);
        break;
    }
  }

  /** Append words to the caption; a new speaker starts a new line. */
  private caption(speaker: "user" | "assistant", text: string): void {
    const key = speaker === "user" ? "you" : "assistant";
    const current = this.lastSpeaker === speaker ? this.state[key] : "";
    this.lastSpeaker = speaker;
    if (speaker === "user") {
      this.update({ you: current + text, status: this.voiceTurnRunning ? "thinking" : "listening" });
      return;
    }
    this.update({ assistant: current + text, status: "speaking" });
    window.clearTimeout(this.speakingTimer);
    this.speakingTimer = window.setTimeout(() => {
      if (!this.ended) this.update({ status: this.voiceTurnRunning ? "thinking" : "listening" });
    }, VOICE_TIMING.speaking);
  }

  /** A delegation: run the request as a chat turn and send the answer back to speak. */
  private async delegate(id: string, text: string): Promise<void> {
    const delegation = ++this.delegation;
    const current = () => delegation === this.delegation && !this.ended;
    if (this.host.turnRunning()) this.host.stopTurn();
    let request = text.trim();
    if (!request) {
      // GPT-Live's delegation carries no text and can come before the
      // user's last words are transcribed.
      await this.inputSettled(Date.now());
      if (!current()) return;
      request = this.pendingInput.trim();
    }
    this.pendingInput = "";
    if (!request) {
      this.sendAll(speakEvents(this.dialect, id, "I didn't catch the request. Ask the user to say it again."));
      return;
    }

    let answer = "";
    let failed = "";
    const progress = (value: string) => {
      if (current()) this.sendAll(progressEvents(this.dialect, id, value));
    };
    // A turn typed while we waited for the transcript is stopped too.
    if (this.host.turnRunning()) this.host.stopTurn();
    this.voiceTurnRunning = true;
    this.update({ status: "thinking" });
    try {
      await this.host.runTurn(request, {
        onToolCall: (name) => {
          if (answer) progress(answer);
          answer = "";
          progress(`Working on it: ${name.replace(/_/g, " ")}.`);
        },
        onText: (value) => { answer = value; },
        onAskUser: (question) => {
          if (current()) this.sendAll(speakEvents(this.dialect, id, `The assistant asks: ${question}`));
        },
        onError: (message) => { failed = message; },
      });
    } finally {
      if (delegation === this.delegation) this.voiceTurnRunning = false;
    }
    if (!current()) return;
    if (answer) this.sendAll(speakEvents(this.dialect, id, spokenAnswer(answer)));
    else if (failed) this.sendAll(speakEvents(this.dialect, id, "That didn't work; the error is shown in the chat."));
    if (this.state.status === "thinking") this.update({ status: "listening" });
  }

  /** Resolves once no new words arrived for `quiet` ms (at most `maxWait` ms). */
  private inputSettled(since: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const now = Date.now();
        const quietFor = now - Math.max(this.lastInputAt, since);
        const waited = now - since;
        if (this.ended || quietFor >= VOICE_TIMING.quiet || waited >= VOICE_TIMING.maxWait) {
          resolve();
          return;
        }
        window.setTimeout(check, Math.min(VOICE_TIMING.quiet - quietFor, VOICE_TIMING.maxWait - waited));
      };
      check();
    });
  }

  private sendAll(events: Record<string, unknown>[]): void {
    for (const event of events) this.session.send(event);
  }

  private onEnded(error?: string): void {
    window.clearTimeout(this.speakingTimer);
    const wasEnded = this.ended;
    this.ended = true;
    // Lost in the background: the bar stays, the view reconnects on the return.
    if (this.background && !wasEnded) return;
    this.host.render(null);
    if (error && !wasEnded) this.host.showError(error);
  }

  private update(changes: Partial<VoiceViewState>): void {
    this.state = { ...this.state, ...changes };
    this.render();
  }

  private render(): void {
    if (!this.ended) this.host.render({ ...this.state });
  }
}
