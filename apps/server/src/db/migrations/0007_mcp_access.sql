CREATE TABLE mcp_access (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  digest BLOB NOT NULL CHECK (length(digest) = 32),
  created_at INTEGER NOT NULL
);
