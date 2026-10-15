/**
 * A fresh Idempotency-Key. Created ONCE per allocation / adjustment and then reused for every
 * retry of it. crypto.randomUUID only exists in secure contexts (https or localhost), and
 * warehouse devices may reach the app over plain http on a LAN, so there is a fallback.
 */
export function newIdempotencyKey(cryptoImpl: Crypto = globalThis.crypto): string {
  if (typeof cryptoImpl.randomUUID === "function") return cryptoImpl.randomUUID();
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
