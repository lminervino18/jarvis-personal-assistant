import { pino, type Logger } from "pino";

/** Structured logger. Message bodies, cookies and tokens are never logged. */
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]', "*.token", "*.password", "*.text", "*.content"],
      censor: "[redacted]",
    },
  });
}
