import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config/env";
import type { GeoDatasets } from "../rules/geo-datasets";
import type { OperationLogService } from "../system/log-service";
import { createMcpServer } from "./server";

const route = "/mcp";
const accessRoute = "/api/system/mcp";
const idleTime = 30 * 60_000;
const keyPattern = /^Bearer (submcp_[A-Za-z0-9_-]{43})$/i;

function digest(key: string) {
  return createHash("sha256").update(key).digest();
}

function rpcError(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

export function registerMcpRoutes(
  app: FastifyInstance,
  config: AppConfig,
  logs: OperationLogService,
  geo: GeoDatasets,
) {
  const sqlite = app.database.sqlite;
  const endpoint = config.PUBLIC_BASE_URL
    ? new URL(route, config.PUBLIC_BASE_URL).href
    : null;
  const allowedOrigins = new Set([new URL(config.WEB_ORIGIN).origin]);
  if (endpoint) allowedOrigins.add(new URL(endpoint).origin);
  const readKey = sqlite.prepare<[], { digest: Buffer; createdAt: number }>(
    "SELECT digest, created_at AS createdAt FROM mcp_access WHERE id = 1",
  );
  const saveKey = sqlite.prepare<[Buffer, number]>(
    "INSERT INTO mcp_access (id, digest, created_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET digest = excluded.digest, created_at = excluded.created_at",
  );
  const revokeKey = sqlite.prepare("DELETE FROM mcp_access WHERE id = 1");
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; lastActive: number }
  >();

  async function closeSessions() {
    const transports = [...sessions.values()].map(({ transport }) => transport);
    sessions.clear();
    await Promise.allSettled(transports.map((transport) => transport.close()));
  }
  app.addHook("preClose", closeSessions);

  function status() {
    const key = readKey.get();
    return {
      endpoint,
      hasApiKey: key !== undefined,
      createdAt: key ? new Date(key.createdAt).toISOString() : null,
    };
  }

  const auth = { onRequest: app.requireAuth };
  app.get(accessRoute, auth, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { ok: true, data: status() };
  });

  app.post(accessRoute, auth, async (request, reply) => {
    if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
      return reply
        .code(403)
        .send({ ok: false, error: { message: "Invalid origin" } });
    }
    const apiKey = "submcp_" + randomBytes(32).toString("base64url");
    saveKey.run(digest(apiKey), Date.now());
    await closeSessions();
    logs.record({
      action: "mcp.rotate-key",
      message: "Generated a new MCP access key",
    });
    reply.header("Cache-Control", "no-store");
    return { ok: true, data: { ...status(), apiKey } };
  });

  app.delete(accessRoute, auth, async (request, reply) => {
    if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
      return reply
        .code(403)
        .send({ ok: false, error: { message: "Invalid origin" } });
    }
    revokeKey.run();
    await closeSessions();
    logs.record({ action: "mcp.revoke-key", message: "Revoked MCP access" });
    return reply.code(204).send();
  });

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: route,
    bodyLimit: 512 * 1024,
    config: { cors: false },
    onRequest: async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.has(origin))
        return rpcError(reply, 403, "Invalid origin");
      const token = request.headers.authorization?.match(keyPattern)?.[1];
      const key = token ? readKey.get() : undefined;
      if (!token || !key || !timingSafeEqual(digest(token), key.digest)) {
        reply.header("WWW-Authenticate", 'Bearer realm="Substation MCP"');
        return rpcError(reply, 401, "Valid MCP API key required");
      }
    },
    handler: async (request, reply) => {
      if (request.method === "GET") {
        reply.header("Allow", "POST, DELETE");
        return rpcError(
          reply,
          405,
          "Standalone notification streams are unavailable",
        );
      }

      const now = Date.now();
      for (const [id, session] of sessions) {
        if (session.lastActive + idleTime > now) continue;
        sessions.delete(id);
        void session.transport.close().catch(() => {});
      }

      const requestedId = request.headers["mcp-session-id"];
      let transport: StreamableHTTPServerTransport;
      if (requestedId !== undefined) {
        const session =
          typeof requestedId === "string"
            ? sessions.get(requestedId)
            : undefined;
        if (!session)
          return rpcError(reply, 404, "MCP session expired or not found");
        session.lastActive = now;
        transport = session.transport;
      } else {
        if (request.method !== "POST" || !isInitializeRequest(request.body)) {
          return rpcError(reply, 400, "Initialize an MCP session first");
        }
        if (sessions.size >= 32)
          return rpcError(reply, 503, "Too many MCP sessions");
        const id = randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => id,
          onsessionclosed: () => {
            sessions.delete(id);
          },
          enableJsonResponse: true,
        });
        sessions.set(id, { transport, lastActive: now });
        try {
          await createMcpServer(app.database, true, geo).connect(transport);
        } catch (error) {
          sessions.delete(id);
          await transport.close();
          throw error;
        }
      }

      reply.hijack();
      reply.raw.setHeader("Cache-Control", "no-store");
      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { "Content-Type": "application/json" });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "MCP request failed" },
              id: null,
            }),
          );
        } else if (!reply.raw.writableEnded) reply.raw.end();
      } finally {
        if (!transport.sessionId) {
          for (const [id, session] of sessions) {
            if (session.transport === transport) sessions.delete(id);
          }
          await transport.close();
        }
      }
    },
  });
}
