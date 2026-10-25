import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface StubServer {
  url: string;
  requests: string[];
  stop(): Promise<void>;
}

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

export async function startStub(handler: Handler): Promise<StubServer> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", () => response.destroy());
    request.on("end", () => {
      requests.push(`${request.method} ${request.url}`);
      handler(request, response, Buffer.concat(chunks).toString("utf8"));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    stop: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}

/** A mono 16-bit WAV holding a quiet sine tone, standing in for a Piper sentence. */
export function toneWav(durationMs: number, sampleRate = 22050): Buffer {
  const samples = Math.round((durationMs * sampleRate) / 1000);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate)), 44 + i * 2);
  return wav;
}

export function slowPiper(delayMs: number): Handler {
  return (_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "audio/wav" });
      response.end(toneWav(400));
    }, delayMs);
  };
}

export const failing: Handler = (_request, response) => {
  response.writeHead(503, { "content-type": "application/json" });
  response.end('{"error":"unavailable"}');
};
