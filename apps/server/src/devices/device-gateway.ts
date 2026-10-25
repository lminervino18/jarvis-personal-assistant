import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { RouteHelpers } from "../app.js";
import { ClientConnection, type ConnectionDeps } from "../ws/client-connection.js";
import type { DeviceRecord, DeviceStore } from "./device-store.js";

const CreateBody = z.object({ name: z.string().trim().min(1).max(60) });
const DeviceParams = z.object({ id: z.uuid() });
const REVOKED_CLOSE_CODE = 4001;

export interface DeviceGatewayDeps {
  devices: DeviceStore;
  connection: Omit<ConnectionDeps, "kind" | "isStillAuthorized">;
}

function bearerToken(request: FastifyRequest): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
}

/**
 * Device pairing routes (owner session only) and `GET /ws/device` for non-browser clients.
 * The socket authenticates with `Authorization: Bearer <device token>`; cookies and Origin play no part.
 */
export function registerDeviceRoutes(app: FastifyInstance, { requireOwner }: RouteHelpers, deps: DeviceGatewayDeps): void {
  const { devices } = deps;
  const sockets = new Map<string, Set<WebSocket>>();
  const authenticated = new WeakMap<FastifyRequest, DeviceRecord>();

  app.post("/api/devices", async (request, reply) => {
    if (!requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const body = CreateBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const { device, token } = devices.create(body.data.name);
    return reply.code(201).send({ ...device, token });
  });

  app.get("/api/devices", async (request, reply) => {
    if (!requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    return { devices: devices.list() };
  });

  app.post("/api/devices/:id/revoke", async (request, reply) => {
    if (!requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = DeviceParams.safeParse(request.params);
    if (!params.success || !devices.revoke(params.data.id)) return reply.code(404).send({ error: "not_found" });
    for (const socket of sockets.get(params.data.id) ?? []) socket.close(REVOKED_CLOSE_CODE, "device revoked");
    return { revoked: true };
  });

  app.get(
    "/ws/device",
    {
      websocket: true,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      preValidation: async (request, reply) => {
        const device = devices.authenticate(bearerToken(request));
        if (!device) return reply.code(401).send({ error: "unauthorized" });
        authenticated.set(request, device);
      },
    },
    (socket, request) => {
      const device = authenticated.get(request) as DeviceRecord;
      const group = sockets.get(device.id) ?? new Set<WebSocket>();
      group.add(socket);
      sockets.set(device.id, group);
      socket.on("close", () => {
        group.delete(socket);
        if (group.size === 0) sockets.delete(device.id);
      });
      new ClientConnection(socket, {
        ...deps.connection,
        kind: "device",
        isStillAuthorized: () => devices.isActive(device.id),
      });
    },
  );
}
