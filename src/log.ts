import { createHash } from 'node:crypto';

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  const line = [new Date().toISOString(), level.toUpperCase().padEnd(5), message];
  if (fields && Object.keys(fields).length > 0) line.push(JSON.stringify(fields));
  const stream = level === 'error' ? console.error : console.log;
  stream(line.join(' '));
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
};

/**
 * Headers whose value may be written down as it arrived.
 *
 * An allowlist, not a list of things to hide. A blacklist only catches the
 * secrets someone thought of, and the one that got out here was stored under
 * the key `value` — exactly the shape a `'token' in name` filter waves
 * through. Anything not named below is reduced to its length and digest,
 * which still separates "the client sent nothing" from "the client sent the
 * wrong thing", and the list can be widened when a real header needs reading.
 */
const PLAIN = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'cdn-loop',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'connection',
  'content-length',
  'content-type',
  'expect',
  'host',
  'last-event-id',
  'mcp-method',
  'mcp-name',
  'mcp-protocol-version',
  'mcp-session-id',
  'origin',
  'pragma',
  'te',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  // The client's own address, which the plain request line already carries.
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

/**
 * Headers that carry a scheme worth keeping in front of the redaction.
 *
 * A client that sends the bare token instead of `Bearer <token>` fails in a
 * way the length alone cannot explain, so the scheme is the one part of
 * these that earns its place in the log.
 */
const SCHEMED = new Set(['authorization', 'proxy-authorization']);

/**
 * Reduce a secret to something safe to write down: eight hex characters of its
 * digest. Two logs can be compared for equality without either holding the
 * secret.
 */
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** Sketch a credential as scheme + length + digest. */
function sketch(value: string): string {
  const [scheme, ...rest] = value.split(' ');
  const secret = rest.length > 0 ? rest.join(' ') : value;
  const prefix = rest.length > 0 ? `${scheme} ` : '';
  return `${prefix}<${secret.length} chars, ${digest(secret)}>`;
}

/** Sketch a value nothing is known about, keeping none of it. */
function opaque(value: string): string {
  return `<${value.length} chars, ${digest(value)}>`;
}

/**
 * Render request headers for a log line, keeping only what is known to be safe.
 *
 * Diagnostic only — it exists to answer "what did the client actually send",
 * which is otherwise invisible from outside the process. Every header still
 * appears; the ones that are not recognised appear as a sketch.
 */
export function describeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const described: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const joined = Array.isArray(value) ? value.join(', ') : value;
    const lower = name.toLowerCase();
    described[name] = PLAIN.has(lower) ? joined : SCHEMED.has(lower) ? sketch(joined) : opaque(joined);
  }
  return described;
}
