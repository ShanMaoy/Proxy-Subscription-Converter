import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app";
import { loadConfig } from "../config/env";

const keyResponse = z.object({ data: z.object({ apiKey: z.string() }) });
const clients: Client[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it("protects remote MCP, grants write access, and invalidates rotated credentials and sessions", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: ":memory:",
    ADMIN_PASSWORD: "test-password",
    SESSION_SECRET: "test-secret-at-least-32-characters",
    PUBLIC_BASE_URL: "https://substation.example.test",
  });
  const app = await createApp({ config });
  apps.push(app);
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const accessPath = base + "/api/system/mcp";
  const mcpUrl = new URL("/mcp", base);
  expect((await fetch(accessPath, { method: "POST" })).status).toBe(401);
  expect((await fetch(mcpUrl)).status).toBe(401);
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  expect(login.ok).toBe(true);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const generate = () =>
    fetch(accessPath, { method: "POST", headers: { Cookie: cookie } });
  expect(
    (
      await fetch(accessPath, {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://untrusted.example" },
      })
    ).status,
  ).toBe(403);
  const issued = await generate();
  expect(issued.headers.get("cache-control")).toBe("no-store");
  const {
    data: { apiKey },
  } = keyResponse.parse(await issued.json());
  expect(apiKey).toMatch(/^submcp_[A-Za-z0-9_-]{43}$/);
  expect(
    await (await fetch(accessPath, { headers: { Cookie: cookie } })).json(),
  ).toMatchObject({
    data: { endpoint: "https://substation.example.test/mcp", hasApiKey: true },
  });
  expect(
    await (await fetch(accessPath, { headers: { Cookie: cookie } })).text(),
  ).not.toContain(apiKey);
  expect(
    await (
      await fetch(base + "/api/system/backup", { headers: { Cookie: cookie } })
    ).text(),
  ).not.toContain(apiKey);
  expect(
    app.database.sqlite
      .prepare("SELECT length(digest) AS length FROM mcp_access")
      .get(),
  ).toEqual({ length: 32 });

  const authorization = "Bearer " + apiKey;
  expect(
    (
      await fetch(mcpUrl, {
        headers: {
          Authorization: authorization,
          Origin: "https://untrusted.example",
        },
      })
    ).status,
  ).toBe(403);
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { Authorization: authorization } },
  });
  const client = new Client({ name: "http-integration", version: "1.0.0" });
  clients.push(client);
  await client.connect(transport);
  expect((await client.listTools()).tools.map(({ name }) => name)).toContain(
    "apply_configuration",
  );
  const plan = await client.callTool({
    name: "plan_configuration",
    arguments: {
      operations: [
        {
          op: "add_rule",
          rule: { ruleType: "DOMAIN", value: "example.org", policy: "DIRECT" },
        },
      ],
    },
  });
  expect(plan.isError).not.toBe(true);
  const applied = await client.callTool({
    name: "apply_configuration",
    arguments: z.object({ planId: z.uuid() }).parse(plan.structuredContent),
  });
  expect(applied.structuredContent).toMatchObject({ applied: true });
  expect(
    app.database.sqlite.prepare("SELECT count(*) AS count FROM rules").get(),
  ).toEqual({ count: 1 });

  const {
    data: { apiKey: replacement },
  } = keyResponse.parse(await (await generate()).json());
  expect(replacement).not.toBe(apiKey);
  await expect(client.listTools()).rejects.toThrow();
  expect(
    (
      await fetch(mcpUrl, {
        method: "DELETE",
        headers: {
          Authorization: "Bearer " + replacement,
          "Mcp-Session-Id": transport.sessionId!,
        },
      })
    ).status,
  ).toBe(404);
  expect(
    (await fetch(accessPath, { method: "DELETE", headers: { Cookie: cookie } }))
      .status,
  ).toBe(204);
  expect(
    (
      await fetch(mcpUrl, {
        headers: { Authorization: "Bearer " + replacement },
      })
    ).status,
  ).toBe(401);
}, 15_000);
