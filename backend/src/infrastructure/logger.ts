import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino'
import { getEnv } from '../config/env.js'

/**
 * 02-technical-prd.md §11 — structured logs with secrets redacted **at the
 * logger**, not at the call site.
 *
 * The distinction is the whole point. "Remember not to log the password" is a
 * rule that holds until the day someone logs `req.body` while debugging at
 * 1 a.m. Configuring the paths here means the leak is impossible rather than
 * discouraged: the same object logged carelessly still comes out `[Redacted]`.
 *
 * The paths cover the shapes secrets actually arrive in — a request body, a
 * header bag, a cookie jar, a token pair — plus a wildcard sweep one level
 * deep, because the next shape is always one nobody listed.
 */
export const REDACTED = '[Redacted]'

const REDACT_PATHS = [
  'password',
  'passwordHash',
  'token',
  'tokens',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'cookie',
  'authorization',
  'secret',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.tokens',
  '*.accessToken',
  '*.refreshToken',
  '*.tokenHash',
  '*.cookie',
  '*.authorization',
  '*.secret',
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
]

export function loggerOptions(): LoggerOptions {
  const env = getEnv()
  return {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    base: { service: 'api' },
    // ISO timestamps: correlating a socket event with a log line by eye is a
    // real activity on this project, and epoch millis make it miserable.
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: true } } }
      : {}),
  }
}

export function createLogger(destination?: DestinationStream): Logger {
  const options = loggerOptions()
  if (destination) {
    // A caller-supplied stream means a test is reading the serialised line, so
    // the pretty transport (which would swallow it) is dropped.
    const { transport: _transport, ...rest } = options
    return pino(rest, destination)
  }
  return pino(options)
}

let cached: Logger | undefined

export function getLogger(): Logger {
  cached ??= createLogger()
  return cached
}

/** Test hook, mirroring `resetEnvCache`. */
export function resetLoggerCache(): void {
  cached = undefined
}
