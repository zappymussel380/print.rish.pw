/**
 * Client-side correlation id. `crypto.randomUUID()` only exists in a secure
 * context (HTTPS or localhost) — it is `undefined` when the app is reached over
 * plain HTTP on a LAN IP, which would throw and silently break uploads. These
 * ids are only used to correlate an in-flight upload with its store row (the
 * real server id replaces the key on success), so a non-crypto fallback is
 * perfectly safe.
 */
export function clientUid(): string {
  return (
    crypto.randomUUID?.() ??
    `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}
