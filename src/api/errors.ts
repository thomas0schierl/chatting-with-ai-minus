/**
 * An error a provider answered with, as every chat adapter throws it: the
 * HTTP status (0 when the error came inside a stream that had started),
 * the provider's error code or type, and how long the provider asked to
 * wait (`Retry-After`). `api/client.ts` decides on a retry from these.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * A streamed answer that ended before the provider said it was complete
 * (the connection dropped or timed out, no error from the provider). The
 * agent loop sends the same request again; no tool ran for it yet.
 */
export class StreamCutError extends Error {
  constructor(provider: string) {
    super(`${provider} stream ended before the answer was complete.`);
    this.name = "StreamCutError";
  }
}
