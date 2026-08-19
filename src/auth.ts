import { timingSafeEqual } from 'node:crypto';

/** Constant-time comparison that does not leak length through its timing. */
function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do the work, so a length mismatch is not the fast path.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Decide whether a request may proceed.
 *
 * An unset token means the endpoint is open — Portcall assumes something in
 * front of it is doing the gating in that case.
 */
export function isAuthorized(authorizationHeader: string | undefined, token: string | undefined): boolean {
  if (token === undefined) return true;
  if (typeof authorizationHeader !== 'string') return false;

  const [scheme, ...rest] = authorizationHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return false;

  return secretEquals(rest.join(' ').trim(), token);
}
