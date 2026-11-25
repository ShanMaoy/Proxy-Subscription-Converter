import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DatabaseConnection } from "../db/database";
import { GeoDatasets } from "../rules/geo-datasets";
import { checkRuleCoverage } from "../rules/rule-coverage";
import { RuleValidationError } from "../rules/service";
import { McpConfiguration, planSchema, profileScope } from "./configuration";

const profile = z.object({ profileId: z.string().min(1).max(200) });
const readOnly = { readOnlyHint: true, openWorldHint: false };

async function reply(
  run: () => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
  try {
    const data = await run();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      structuredContent: data,
    };
  } catch (error) {
    const message =
      error instanceof RuleValidationError
        ? error.message
        : error instanceof z.ZodError
          ? error.issues
              .map((issue) => issue.path.join(".") + ": " + issue.message)
              .join("; ")
          : "Configuration operation failed";
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  }
}

export function createMcpServer(
  database: DatabaseConnection,
  writable = true,
  geo = new GeoDatasets(database),
) {
  const configuration = new McpConfiguration(database);
  const server = new McpServer(
    { name: "substation", version: "0.1.0" },
    {
      instructions:
        "Use list_output_profiles to find profile IDs. Global rules are shared; proxy groups and Rule Providers belong to a Clash/Mihomo profile. Preview changes with plan_configuration, show them to the user, and wait for approval before calling apply_configuration.",
    },
  );

  server.registerTool(
    "list_output_profiles",
    {
      description:
        "List output profile IDs, target clients and whether each one inherits global rules.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () => reply(() => ({ profiles: configuration.listProfiles() })),
  );

  server.registerTool(
    "list_rules",
    {
      description:
        "Read rules in effective match order, with IDs for edits. Omit profileId for global rules.",
      inputSchema: profileScope.extend({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: readOnly,
    },
    ({ profileId, offset, limit }) =>
      reply(() => {
        const rules = configuration.readRules(profileId);
        return {
          total: rules.length,
          rules: rules.slice(offset, offset + limit),
        };
      }),
  );

  server.registerTool(
    "list_proxy_groups",
    {
      description:
        "Read custom proxy groups for an output, including group names, members, filters and latency-test settings.",
      inputSchema: profile,
      annotations: readOnly,
    },
    ({ profileId }) =>
      reply(() => ({ groups: configuration.listGroups(profileId) })),
  );

  server.registerTool(
    "list_rule_providers",
    {
      description:
        "Read the Rule Providers configured for an output, including their names, types, format and update interval.",
      inputSchema: profile,
      annotations: readOnly,
    },
    ({ profileId }) =>
      reply(() => ({ providers: configuration.listProviders(profileId) })),
  );

  server.registerTool(
    "list_subscription_sources",
    {
      description:
        "Read subscription source names, IDs, enabled state and last refresh status.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () => reply(() => ({ sources: configuration.listSources() })),
  );

  server.registerTool(
    "check_output",
    {
      description:
        "Validate whether an output can be generated from current sources and inspect node counts and warnings.",
      inputSchema: profile,
      annotations: readOnly,
    },
    ({ profileId }) => reply(() => configuration.checkOutput(profileId)),
  );

  server.registerTool(
    "check_rule_coverage",
    {
      description:
        "Check current rules for a domain or IP. Uses server DNS when needed and Geo datasets. Write-enabled sessions can fetch missing or stale Geo datasets. Actual client routing may differ.",
      inputSchema: profileScope.extend({
        target: z.string().trim().min(1).max(253),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ target, profileId }) =>
      reply(async () => {
        const result = await checkRuleCoverage(
          target,
          configuration.readRules(profileId),
          {
            get: (kind, category) =>
              geo.get(kind, category, { cachedOnly: !writable }),
          },
        );
        return { ...result };
      }),
  );

  server.registerTool(
    "geo_dataset_status",
    {
      description:
        "List GeoIP/GeoSite categories and their last synchronization times.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () => reply(() => ({ datasets: geo.status() })),
  );

  server.registerTool(
    "plan_configuration",
    {
      description:
        "Preview a batch without changing saved configuration. Supports add, update, remove, move, or reorder rules, and setting or removing custom proxy groups and Rule Providers. Profile-scoped rule edits enable independent rules. Review the returned plan with the user before applying.",
      inputSchema: planSchema,
      annotations: readOnly,
    },
    (input) => reply(() => configuration.plan(input)),
  );

  if (writable) {
    server.registerTool(
      "apply_configuration",
      {
        description:
          "Apply a previously reviewed plan by ID, only after the user approves it. The plan expires after five minutes and rejects concurrent configuration changes.",
        inputSchema: z.object({ planId: z.uuid() }),
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      ({ planId }) => reply(() => configuration.apply(planId)),
    );

    server.registerTool(
      "sync_geo_datasets",
      {
        description:
          "Refresh the managed GeoIP/GeoSite caches from the configured MetaCubeX catalog.",
        inputSchema: z.object({}),
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      () => reply(async () => ({ ...(await geo.sync()) })),
    );
  }

  return server;
}
