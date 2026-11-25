import { loadConfig } from "../config/env";
import { initializeDatabase, resolveDatabasePath } from "./database";

const config = loadConfig();
const connection = initializeDatabase(config.DATABASE_URL);
connection.close();

console.log(
  `Database initialized at ${resolveDatabasePath(config.DATABASE_URL)}`,
);
