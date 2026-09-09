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

/** Header values that must never reach the log file verbatim. */
const SENSITIVE = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'x-auth-token', 'cookie']);

/**
 * Reduce a secret to something safe to write down: eight hex characters of its
 * digest. Two logs can be compared for equality without either holding the
 * secret.
 */
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * Sketch a sensitive header value as scheme + length + digest.
 *
 * The scheme is kept in the clear because its absence is the likeliest
 * misconfiguration: a client that sends the bare token instead of
 * `Bearer <token>` fails authentication in a way the length alone cannot
 * explain.
 */
function sketch(value: string): string {
  const [scheme, ...rest] = value.split(' ');
  const secret = rest.length > 0 ? rest.join(' ') : value;
  const prefix = rest.length > 0 ? `${scheme} ` : '';
  return `${prefix}<${secret.length} chars, ${digest(secret)}>`;
}

/**
 * Render request headers for a log line, redacting the sensitive ones.
 *
 * Diagnostic only — it exists to answer "what did the client actually send",
 * which is otherwise invisible from outside the process.
 */
export function describeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const described: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const joined = Array.isArray(value) ? value.join(', ') : value;
    described[name] = SENSITIVE.has(name.toLowerCase()) ? sketch(joined) : joined;
  }
  return described;
}
