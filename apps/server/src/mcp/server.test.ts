import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const sessions: Client[] = [];
const directories: string[] = [];

function makeDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), "substation-mcp-"));
  directories.push(directory);
  return join(directory, "data.sqlite");
}

async function connect(database: string, writable = true) {
  const client = new Client({ name: "substation-test", version: "1.0.0" });
  sessions.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(
          join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs"),
        ).href,
        join(process.cwd(), "src", "mcp", "index.ts"),
        ...(writable ? [] : ["--read-only"]),
      ],
      cwd: tmpdir(),
      env: { DATABASE_URL: database },
    }),
  );
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as Record<string, unknown>;
}

const directRule = {
  ruleType: "DOMAIN-SUFFIX",
  value: "huya.com",
  policy: "DIRECT",
};
const fallback = {
  op: "add_rule",
  rule: { ruleType: "MATCH", policy: "PROXY" },
};

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((client) => client.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Substation MCP over stdio", () => {
  it("lists read-only tools and prepares an unapplied plan in read-only mode", async () => {
    const client = await connect(makeDatabasePath(), false);
    const list = await client.listTools();
    expect(list.tools.map((tool) => tool.name)).toContain("plan_configuration");
    expect(list.tools.map((tool) => tool.name)).not.toContain(
      "apply_configuration",
    );
    expect(await call(client, "list_output_profiles")).toMatchObject({
      profiles: [
        expect.objectContaining({ id: "default-clash", targetClient: "clash" }),
        expect.any(Object),
      ],
    });
    expect(
      JSON.stringify(await call(client, "list_output_profiles")),
    ).not.toContain("subscriptionUrl");
    const plan = await call(client, "plan_configuration", {
      operations: [fallback],
    });
    expect(plan).toMatchObject({ ruleCount: { before: 0, after: 1 } });
    expect(await call(client, "list_rules")).toEqual({ total: 0, rules: [] });
  }, 15_000);

  it("applies reviewed global and profile changes and rejects stale plans", async () => {
    const database = makeDatabasePath();
    const first = await connect(database);
    const second = await connect(database);
    const plan = await call(first, "plan_configuration", {
      operations: [fallback, { op: "add_rule", rule: directRule }],
    });
    await call(first, "apply_configuration", { planId: plan.planId });
    expect((await call(first, "list_rules")).rules).toMatchObject([
      directRule,
      { ruleType: "MATCH" },
    ]);
    expect(
      await call(first, "check_rule_coverage", { target: "www.huya.com" }),
    ).toMatchObject({ matches: [{ value: "huya.com", policy: "DIRECT" }] });
    expect(
      (
        await first.callTool({
          name: "apply_configuration",
          arguments: { planId: plan.planId },
        })
      ).isError,
    ).toBe(true);

    const scope = { profileId: "default-clash" };
    const stale = await call(second, "plan_configuration", {
      ...scope,
      operations: [
        { op: "add_rule", rule: { ...directRule, value: "stale.example" } },
      ],
    });
    const custom = await call(first, "plan_configuration", {
      ...scope,
      operations: [
        {
          op: "set_proxy_group",
          group: {
            name: "Gaming",
            type: "select",
            proxies: ["DIRECT", "PROXY"],
          },
        },
        {
          op: "set_rule_provider",
          name: "gaming",
          provider: {
            type: "inline",
            behavior: "domain",
            payload: ["+.games.example"],
          },
        },
        {
          op: "add_rule",
          rule: { ruleType: "RULE-SET", value: "gaming", policy: "Gaming" },
        },
      ],
    });
    expect(custom.switchesToCustomRules).toBe(true);
    await call(first, "apply_configuration", { planId: custom.planId });
    expect(await call(first, "list_proxy_groups", scope)).toMatchObject({
      groups: [{ name: "Gaming", proxies: ["DIRECT", "PROXY"] }],
    });
    expect(await call(first, "list_rule_providers", scope)).toMatchObject({
      providers: [{ name: "gaming", payloadCount: 1 }],
    });
    const staleResult = await second.callTool({
      name: "apply_configuration",
      arguments: { planId: stale.planId },
    });
    expect(staleResult.isError).toBe(true);
    expect(JSON.stringify(staleResult.content)).toContain(
      "Configuration changed after preview",
    );

    const rules = (await call(first, "list_rules", scope)).rules as {
      id: string;
      ruleType: string;
    }[];
    const invalid = await first.callTool({
      name: "plan_configuration",
      arguments: {
        ...scope,
        operations: [{ op: "remove_rule_provider", name: "gaming" }],
      },
    });
    expect(invalid.isError).toBe(true);
    const move = await call(first, "plan_configuration", {
      ...scope,
      operations: [{ op: "move_rule", id: rules[1].id, beforeId: rules[0].id }],
    });
    await call(first, "apply_configuration", { planId: move.planId });
    expect((await call(first, "list_rules", scope)).rules).toMatchObject([
      { ruleType: "RULE-SET" },
      directRule,
      { ruleType: "MATCH" },
    ]);
    expect((await call(first, "list_rules")).rules).toHaveLength(2);
  }, 15_000);
});
