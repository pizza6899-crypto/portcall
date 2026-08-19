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
