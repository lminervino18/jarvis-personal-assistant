import { pino, type DestinationStream, type Logger } from "pino";

interface LoggedRequest {
  method?: string;
  url?: string;
}

interface LoggedReply {
  statusCode?: number;
}

/**
 * Structured logger. Message bodies, cookies, tokens and query strings (OAuth codes and
 * states travel there) are never logged.
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      serializers: {
        req: (req: LoggedRequest) => ({ method: req.method, path: (req.url ?? "").split("?")[0] }),
        res: (res: LoggedReply) => ({ statusCode: res.statusCode }),
      },
      redact: {
        paths: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]', "*.token", "*.password", "*.text", "*.content"],
        censor: "[redacted]",
      },
    },
    destination,
  );
}
