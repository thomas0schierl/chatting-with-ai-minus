/**
 * RS256 signature check (RSASSA-PKCS1-v1_5 with SHA-256, RFC 8017 8.2.2)
 * for ID tokens, in plain JS with BigInt. SubtleCrypto may be missing in
 * mobile WebViews; @noble/hashes supplies SHA-256. Only verification with
 * a public key: no secrets are involved, so timing doesn't matter.
 */
import { sha256 } from "@noble/hashes/sha2.js";

/** An RSA key from a JWKS document (RFC 7517). */
export interface RsaJwk {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

/** DER prefix of DigestInfo for SHA-256 (RFC 8017 9.2, note 1). */
const SHA256_DIGEST_INFO = "3031300d060960864801650304020105000420";
/** Keys under 2048 bits are refused. */
const MIN_KEY_BYTES = 256;

const toHex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

/** Decode base64url without padding; undefined if the text isn't base64url. */
export function base64UrlDecode(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function toBigInt(bytes: Uint8Array): bigint {
  return bytes.length ? BigInt(`0x${toHex(bytes)}`) : 0n;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

/** True if `signature` is a valid RS256 signature of `signingInput` by `key`. */
export function verifyRs256(signingInput: string, signature: Uint8Array, key: RsaJwk): boolean {
  if (key.kty !== "RSA" || !key.n || !key.e || (key.alg && key.alg !== "RS256")) return false;
  const nBytes = base64UrlDecode(key.n);
  const eBytes = base64UrlDecode(key.e);
  if (!nBytes || !eBytes) return false;
  const n = toBigInt(nBytes);
  const e = toBigInt(eBytes);
  const k = Math.ceil(n.toString(16).length / 2);
  if (k < MIN_KEY_BYTES || e < 3n || signature.length !== k) return false;
  const s = toBigInt(signature);
  if (s >= n) return false;
  // EM = 0x00 01 FF..FF 00 || DigestInfo || SHA-256(message), k bytes.
  const encoded = modPow(s, e, n).toString(16).padStart(k * 2, "0");
  const tail = SHA256_DIGEST_INFO + toHex(sha256(new TextEncoder().encode(signingInput)));
  const expected = `0001${"ff".repeat(k - 3 - tail.length / 2)}00${tail}`;
  return encoded === expected;
}
