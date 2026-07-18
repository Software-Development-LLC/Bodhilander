import type { LogLevel } from './config';

/**
 * Tiny JSON-lines logger — one JSON object per line on stdout (stderr for
 * warn/error). No dependencies; messages below the configured level are
 * dropped. Log level comes from LOG_LEVEL via `loadConfig`.
 */

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function createLogger(level: LogLevel): Logger {
  const min = LEVEL_ORDER[level];

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[lvl] < min) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields });
    const stream = lvl === 'warn' || lvl === 'error' ? process.stderr : process.stdout;
    stream.write(line + '\n');
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
