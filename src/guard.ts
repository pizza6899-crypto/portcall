/**
 * Per-client abuse control.
 *
 * Cloudflare can rate-limit by request volume, but it cannot see whether a
 * token was right — and "five wrong tokens" is a far sharper signal than "five
 * hundred requests". That judgement only exists here, so the lockout lives
 * here too.
 *
 * State is in memory and dies with the process. A restart forgives everyone,
 * which is the right trade for a gateway whose whole failure mode is locking
 * out its own owner.
 */

export interface GuardOptions {
  /** Auth failures within `windowMs` that trip a block. `0` disables the lockout. */
  failureLimit: number;
  /** How far back failures are counted. */
  windowMs: number;
  /** How long a tripped client stays blocked. */
  blockMs: number;
  /** Requests per client within `rateWindowMs`. `0` disables the cap. */
  rateLimit: number;
  rateWindowMs: number;
}

export type Refusal =
  | { allowed: true }
  | { allowed: false; reason: 'blocked' | 'rate_limited'; retryAfterSeconds: number };

export interface Guard {
  /** Whether this client may be served right now. */
  check(client: string, now: number): Refusal;
  /** Record a failed authentication. Returns true when it tripped a block. */
  recordFailure(client: string, now: number): boolean;
  /** Record a success, clearing the client's failure history. */
  recordSuccess(client: string): void;
  /** Clients currently blocked — for the operator, not for callers. */
  blockedCount(now: number): number;
}

interface Entry {
  /** Timestamps of recent auth failures. */
  failures: number[];
  /** Timestamps of recent requests. */
  requests: number[];
  /** When an active block expires. */
  blockedUntil: number;
}

/** Drop timestamps that have aged out of the window. */
function recent(times: number[], since: number): number[] {
  // Timestamps are appended in order, so the keepers are always a suffix.
  let first = 0;
  while (first < times.length && times[first]! <= since) first += 1;
  return first === 0 ? times : times.slice(first);
}

export function createGuard(options: GuardOptions): Guard {
  const { failureLimit, windowMs, blockMs, rateLimit, rateWindowMs } = options;
  const entries = new Map<string, Entry>();

  function entry(client: string): Entry {
    let found = entries.get(client);
    if (found === undefined) {
      found = { failures: [], requests: [], blockedUntil: 0 };
      entries.set(client, found);
    }
    return found;
  }

  /** Forget clients with nothing left to remember, so the map cannot grow forever. */
  function prune(now: number): void {
    const horizon = now - Math.max(windowMs, rateWindowMs);
    for (const [client, state] of entries) {
      if (state.blockedUntil > now) continue;
      state.failures = recent(state.failures, horizon);
      state.requests = recent(state.requests, horizon);
      if (state.failures.length === 0 && state.requests.length === 0) entries.delete(client);
    }
  }

  let lastPrune = 0;

  return {
    check(client, now) {
      if (now - lastPrune > rateWindowMs) {
        prune(now);
        lastPrune = now;
      }

      const state = entry(client);

      if (state.blockedUntil > now) {
        return {
          allowed: false,
          reason: 'blocked',
          retryAfterSeconds: Math.ceil((state.blockedUntil - now) / 1000),
        };
      }

      if (rateLimit > 0) {
        state.requests = recent(state.requests, now - rateWindowMs);
        if (state.requests.length >= rateLimit) {
          const oldest = state.requests[0] ?? now;
          return {
            allowed: false,
            reason: 'rate_limited',
            retryAfterSeconds: Math.max(1, Math.ceil((oldest + rateWindowMs - now) / 1000)),
          };
        }
        state.requests.push(now);
      }

      return { allowed: true };
    },

    recordFailure(client, now) {
      if (failureLimit <= 0) return false;

      const state = entry(client);
      state.failures = [...recent(state.failures, now - windowMs), now];

      if (state.failures.length >= failureLimit) {
        state.blockedUntil = now + blockMs;
        state.failures = [];
        return true;
      }
      return false;
    },

    recordSuccess(client) {
      // A client that proves it holds the token is not mid-guess. Without
      // this, a long-lived connector would accumulate stray failures until an
      // unrelated hiccup locked it out.
      const state = entries.get(client);
      if (state !== undefined) state.failures = [];
    },

    blockedCount(now) {
      let blocked = 0;
      for (const state of entries.values()) if (state.blockedUntil > now) blocked += 1;
      return blocked;
    },
  };
}

/** Addresses that mean "this machine", where a proxy header is the only real client identity. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

/**
 * Work out who a request is really from.
 *
 * cloudflared proxies from this same machine, so the socket address is always
 * loopback and useless for telling clients apart. `cf-connecting-ip` carries
 * the real one — but only trustworthy while nothing else can reach the
 * listener, which is exactly what binding to loopback guarantees. Bound to a
 * public interface, anyone can set that header, so it is ignored there.
 */
export function clientAddress(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  socketAddress: string | undefined,
  trustProxyHeader: boolean,
): string {
  if (trustProxyHeader) {
    const forwarded = headers['cf-connecting-ip'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return socketAddress ?? 'unknown';
}
