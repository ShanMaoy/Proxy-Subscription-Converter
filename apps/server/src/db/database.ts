import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { databaseSchema } from "./schema";
import { seedDefaultOutputProfiles } from "./defaults";

const migrations = [
  {
    id: "0000_initial",
    path: fileURLToPath(
      new URL("./migrations/0000_initial.sql", import.meta.url),
    ),
  },
  {
    id: "0001_source_auto_refresh",
    path: fileURLToPath(
      new URL("./migrations/0001_source_auto_refresh.sql", import.meta.url),
    ),
  },
  {
    id: "0002_source_traffic_info",
    path: fileURLToPath(
      new URL("./migrations/0002_source_traffic_info.sql", import.meta.url),
    ),
  },
  {
    id: "0003_subscription_access_logs",
    path: fileURLToPath(
      new URL(
        "./migrations/0003_subscription_access_logs.sql",
        import.meta.url,
      ),
    ),
  },
  {
    id: "0004_rule_no_resolve",
    path: fileURLToPath(
      new URL("./migrations/0004_rule_no_resolve.sql", import.meta.url),
    ),
  },
  {
    id: "0005_output_revision",
    path: fileURLToPath(
      new URL("./migrations/0005_output_revision.sql", import.meta.url),
    ),
  },
  {
    id: "0006_ai_and_source_metadata",
    path: fileURLToPath(
      new URL("./migrations/0006_ai_and_source_metadata.sql", import.meta.url),
    ),
  },
] as const;

export type DatabaseConnection = ReturnType<typeof createDatabase>;

export function resolveDatabasePath(databaseUrl: string) {
  if (databaseUrl === ":memory:") {
    return databaseUrl;
  }
  return resolve(databaseUrl);
}

export function createDatabase(databaseUrl: string) {
  const databasePath = resolveDatabasePath(databaseUrl);
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const sqlite = new BetterSqlite3(databasePath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");

  return {
    db: drizzle(sqlite, { schema: databaseSchema }),
    sqlite,
    close: () => sqlite.close(),
  };
}

export function runMigrations(connection: DatabaseConnection) {
  connection.sqlite
    .transaction(() => {
      connection.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __migrations (
        id TEXT PRIMARY KEY NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
      const list = connection.sqlite.prepare<[], { id: string }>(
        "SELECT id FROM __migrations",
      );
      const applied = new Set(list.all().map(({ id }) => id));
      const freshDatabase = !applied.has(migrations[0].id);
      const record = connection.sqlite.prepare(
        "INSERT INTO __migrations (id, applied_at) VALUES (?, ?)",
      );
      for (const migration of migrations) {
        if (applied.has(migration.id)) continue;
        connection.sqlite.exec(readFileSync(migration.path, "utf8"));
        record.run(migration.id, Date.now());
      }
      if (freshDatabase) seedDefaultOutputProfiles(connection);
    })
    .immediate();
}

export function initializeDatabase(databaseUrl: string) {
  const connection = createDatabase(databaseUrl);
  try {
    runMigrations(connection);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}
