ALTER TABLE subscription_sources ADD COLUMN local_proxies_count INTEGER;

CREATE TABLE ai_assistant_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL
);

CREATE TABLE geo_datasets (
  kind TEXT NOT NULL CHECK (kind IN ('geoip', 'geosite')),
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, category)
);
