/**
 * Keeps the screen on while an answer is generated or a voice call runs, so
 * a phone doesn't go to sleep in the middle (the web's Screen Wake Lock API,
 * no Obsidian internals). Each user holds it with `hold()` and lets go with
 * the function that returns; the lock lasts while anyone holds it. The
 * system drops the lock when the app goes to the background, so it is asked
 * for again when the app is back. Where the API is missing, nothing happens.
 */
import { appLifecycle } from "./lifecycle";

class ScreenAwake {
  private holders = 0;
  private lock: WakeLockSentinel | null = null;
  private requesting = false;
  private unwatch: (() => void) | null = null;

  /** Keep the screen on until the returned function is called (once is enough). */
  hold(): () => void {
    this.holders++;
    this.unwatch ??= appLifecycle.onVisible(() => void this.sync());
    void this.sync();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders--;
      void this.sync();
    };
  }

  /** Let go of everything (the plugin unloads). */
  reset(): void {
    this.holders = 0;
    this.unwatch?.();
    this.unwatch = null;
    void this.release();
  }

  private async sync(): Promise<void> {
    if (this.holders === 0) {
      await this.release();
      return;
    }
    if ((this.lock && !this.lock.released) || this.requesting) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    this.requesting = true;
    try {
      this.lock = await navigator.wakeLock.request("screen");
    } catch {
      // Refused (e.g. battery saver) or not allowed here: the screen sleeps as usual.
      this.lock = null;
    } finally {
      this.requesting = false;
    }
    // Everyone let go while it was being requested.
    if (this.holders === 0) await this.release();
  }

  private async release(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    if (lock && !lock.released) await lock.release().catch(() => undefined);
  }
}

/** The one instance for the plugin. */
export const screenAwake = new ScreenAwake();
