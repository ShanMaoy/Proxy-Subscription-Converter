CREATE TABLE output_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
INSERT INTO output_revision (id, version) VALUES (1, 0);

CREATE TRIGGER output_revision_output_profiles_insert
AFTER INSERT ON output_profiles
BEGIN
  UPDATE output_revision SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER output_revision_output_profiles_update
AFTER UPDATE ON output_profiles
BEGIN
  UPDATE output_revision SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER output_revision_output_profiles_delete
AFTER DELETE ON output_profiles
BEGIN
  UPDATE output_revision SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER output_revision_rules_insert
AFTER INSERT ON rules
BEGIN
  UPDATE output_revision SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER output_revision_rules_update
AFTER UPDATE ON rules
BEGIN
  UPDATE output_revision SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER output_revision_rules_delete
AFTER DELETE ON rules
BEGIN
  UPDATE output_revision SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER output_revision_subscription_sources_insert
AFTER INSERT ON subscription_sources
BEGIN
  UPDATE output_revision SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER output_revision_subscription_sources_update
AFTER UPDATE OF name, type, raw_content, enabled ON subscription_sources
BEGIN
  UPDATE output_revision SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER output_revision_subscription_sources_delete
AFTER DELETE ON subscription_sources
BEGIN
  UPDATE output_revision SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER output_revision_subscription_cache_insert
AFTER INSERT ON subscription_cache
BEGIN
  UPDATE output_revision SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER output_revision_subscription_cache_update
AFTER UPDATE ON subscription_cache
BEGIN
  UPDATE output_revision SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER output_revision_subscription_cache_delete
AFTER DELETE ON subscription_cache
BEGIN
  UPDATE output_revision SET version = version + 1 WHERE id = 1;
END;
