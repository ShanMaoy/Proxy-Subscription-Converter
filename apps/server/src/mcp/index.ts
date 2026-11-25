import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initializeDatabase } from "../db/database";
import { GeoDatasets } from "../rules/geo-datasets";
import { createMcpServer } from "./server";

async function main() {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== "--write" && flag !== "--read-only")) {
    throw new Error("Usage: node --import tsx src/mcp/index.ts [--read-only]");
  }
  const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
  const configuredDatabase =
    process.env.DATABASE_URL ?? "data/subscription-converter.sqlite";
  const databasePath =
    isAbsolute(configuredDatabase) || configuredDatabase === ":memory:"
      ? configuredDatabase
      : resolve(serverRoot, configuredDatabase);
  const database = initializeDatabase(databasePath);
  try {
    const geo = new GeoDatasets(database);
    const server = createMcpServer(
      database,
      !flags.includes("--read-only"),
      geo,
    );
    server.server.onclose = () => {
      void geo.stop().finally(() => database.close());
    };
    await server.connect(new StdioServerTransport());
  } catch (error) {
    database.close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "MCP startup failed");
  process.exitCode = 1;
});
