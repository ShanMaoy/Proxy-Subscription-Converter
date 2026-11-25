import { createHash, randomUUID } from "node:crypto";
import {
  createUserRuleSchema,
  outputProfileOptionsSchema,
  proxyGroupSchema,
  ruleProviderNameSchema,
  ruleProviderSchema,
  updateUserRuleSchema,
  userRuleSchema,
  type OutputProfileOptions,
  type ProxyGroup,
  type RuleProvider,
  type UserRule,
} from "@subscription-converter/shared";
import { z } from "zod";
import type { DatabaseConnection } from "../db/database";
import { OutputAvailabilityService } from "../output/availability-service";
import { OutputProfileService } from "../output/profile-service";
import { OutputRepository } from "../output/repository";
import { RuleRepository } from "../rules/repository";
import {
  RuleService,
  RuleValidationError,
  validateRuleSet,
} from "../rules/service";
import { OperationLogService } from "../system/log-service";

const id = z.string().min(1).max(200);
const groupName = proxyGroupSchema.shape.name;
const position = id
  .nullable()
  .optional()
  .describe(
    "Insert before this rule ID. Null means append. Adding without a position inserts before the enabled MATCH rule.",
  );
const operationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_rule"),
    rule: createUserRuleSchema,
    beforeId: position,
  }),
  z.object({ op: z.literal("update_rule"), id, rule: updateUserRuleSchema }),
  z.object({ op: z.literal("remove_rule"), id }),
  z.object({ op: z.literal("move_rule"), id, beforeId: position }),
  z.object({ op: z.literal("reorder_rules"), ids: id.array().max(10_000) }),
  z.object({
    op: z.literal("set_proxy_group"),
    group: proxyGroupSchema.strip(),
  }),
  z.object({ op: z.literal("remove_proxy_group"), name: groupName }),
  z.object({
    op: z.literal("set_rule_provider"),
    name: ruleProviderNameSchema,
    provider: ruleProviderSchema.strip().safeExtend({
      format: z.enum(["yaml", "text", "mrs"]).optional(),
    }),
  }),
  z.object({
    op: z.literal("remove_rule_provider"),
    name: ruleProviderNameSchema,
  }),
]);
export const profileScope = z.object({
  profileId: id
    .optional()
    .describe("Output profile ID. Omit to use global rules."),
});
export const planSchema = profileScope.extend({
  operations: operationSchema.array().min(1).max(100),
});
type Operation = z.infer<typeof operationSchema>;
type Snapshot = {
  rules: UserRule[];
  profile?: { id: string; optionsJson: string; targetClient: string };
  options?: OutputProfileOptions;
};
type Plan = {
  expiresAt: number;
  profileId?: string;
  revision: string;
  rules?: UserRule[];
  options?: OutputProfileOptions;
  operationCount: number;
};
const planLifetime = 5 * 60_000;

function revisionOf(snapshot: Snapshot) {
  return createHash("sha256")
    .update(JSON.stringify([snapshot.profile, snapshot.rules]))
    .digest("hex");
}

function originOf(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function groupSummary(group: ProxyGroup) {
  return {
    name: group.name,
    type: group.type,
    proxies: group.proxies,
    filter: group.filter,
    interval: group.interval,
    tolerance: group.tolerance,
    testUrlOrigin: originOf(group.url),
  };
}

function providerSummary(name: string, provider: RuleProvider) {
  return {
    name,
    type: provider.type,
    behavior: provider.behavior,
    format: provider.format,
    interval: provider.interval,
    path: provider.path,
    urlOrigin: originOf(provider.url),
    payloadCount: provider.payload?.length ?? 0,
  };
}

function review(operation: Operation) {
  if (operation.op === "set_proxy_group")
    return { op: operation.op, group: groupSummary(operation.group) };
  if (operation.op === "set_rule_provider")
    return {
      op: operation.op,
      provider: providerSummary(operation.name, operation.provider),
    };
  return operation;
}

function ruleIndex(rules: UserRule[], ruleId: string) {
  const index = rules.findIndex((rule) => rule.id === ruleId);
  if (index < 0) throw new RuleValidationError("Unknown rule ID: " + ruleId);
  return index;
}

function insertRule(
  rules: UserRule[],
  rule: UserRule,
  beforeId: string | null | undefined,
) {
  const index = beforeId ? ruleIndex(rules, beforeId) : rules.length;
  rules.splice(index, 0, rule);
}

function validateReferences(
  before: OutputProfileOptions,
  after: OutputProfileOptions,
  rules: UserRule[],
) {
  const enabledRules = rules.filter((rule) => rule.enabled);
  const groupNames = new Set(after.proxyGroups.map((group) => group.name));
  for (const group of before.proxyGroups) {
    if (
      groupNames.has(group.name) ||
      ["PROXY", "AUTO", "DIRECT", "REJECT"].includes(group.name)
    )
      continue;
    if (
      after.matchPolicy === group.name ||
      after.proxyGroups.some((entry) => entry.proxies.includes(group.name)) ||
      enabledRules.some((rule) => rule.policy === group.name)
    )
      throw new RuleValidationError(
        "Proxy group is still referenced: " + group.name,
      );
  }
  for (const name of Object.keys(before.ruleProviders)) {
    if (
      !Object.hasOwn(after.ruleProviders, name) &&
      enabledRules.some(
        (rule) => rule.ruleType === "RULE-SET" && rule.value === name,
      )
    ) {
      throw new RuleValidationError(
        "Rule Provider is still referenced: " + name,
      );
    }
  }
}

function applyToDraft(snapshot: Snapshot, operations: Operation[]) {
  const rules = [...snapshot.rules];
  const options = snapshot.options
    ? structuredClone(snapshot.options)
    : undefined;
  const now = new Date().toISOString();
  let changedRules = false;
  let changedOptions = false;
  for (const operation of operations) {
    switch (operation.op) {
      case "add_rule": {
        const fallback =
          operation.rule.ruleType === "MATCH"
            ? undefined
            : rules.find((rule) => rule.enabled && rule.ruleType === "MATCH")
                ?.id;
        insertRule(
          rules,
          userRuleSchema.parse({
            ...operation.rule,
            id: randomUUID(),
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          }),
          operation.beforeId === undefined ? fallback : operation.beforeId,
        );
        changedRules = true;
        break;
      }
      case "update_rule": {
        const index = ruleIndex(rules, operation.id);
        rules[index] = userRuleSchema.parse({
          ...rules[index],
          ...operation.rule,
          updatedAt: now,
        });
        changedRules = true;
        break;
      }
      case "remove_rule":
        rules.splice(ruleIndex(rules, operation.id), 1);
        changedRules = true;
        break;
      case "move_rule": {
        const index = ruleIndex(rules, operation.id);
        if (operation.beforeId !== operation.id) {
          const [rule] = rules.splice(index, 1);
          insertRule(rules, rule, operation.beforeId);
          changedRules = true;
        }
        break;
      }
      case "reorder_rules": {
        const byId = new Map(rules.map((rule) => [rule.id, rule]));
        if (
          operation.ids.length !== rules.length ||
          new Set(operation.ids).size !== rules.length ||
          operation.ids.some((entry) => !byId.has(entry))
        ) {
          throw new RuleValidationError(
            "Reorder must include every rule exactly once",
          );
        }
        rules.splice(
          0,
          rules.length,
          ...operation.ids.map((entry) => byId.get(entry)!),
        );
        changedRules = true;
        break;
      }
      default: {
        if (!options || snapshot.profile?.targetClient !== "clash") {
          throw new RuleValidationError(
            "Proxy groups and Rule Providers require a Clash/Mihomo output profile",
          );
        }
        if (operation.op === "set_proxy_group") {
          const index = options.proxyGroups.findIndex(
            (group) => group.name === operation.group.name,
          );
          if (index < 0) options.proxyGroups.push(operation.group);
          else
            options.proxyGroups[index] = {
              ...options.proxyGroups[index],
              ...operation.group,
            };
        } else if (operation.op === "remove_proxy_group") {
          const index = options.proxyGroups.findIndex(
            (group) => group.name === operation.name,
          );
          if (index < 0)
            throw new RuleValidationError(
              "Unknown proxy group: " + operation.name,
            );
          options.proxyGroups.splice(index, 1);
        } else if (operation.op === "set_rule_provider") {
          const existing = Object.hasOwn(options.ruleProviders, operation.name)
            ? options.ruleProviders[operation.name]
            : undefined;
          options.ruleProviders = {
            ...options.ruleProviders,
            [operation.name]: { ...existing, ...operation.provider },
          };
        } else {
          if (!Object.hasOwn(options.ruleProviders, operation.name)) {
            throw new RuleValidationError(
              "Unknown Rule Provider: " + operation.name,
            );
          }
          delete options.ruleProviders[operation.name];
        }
        changedOptions = true;
      }
    }
  }
  const ordered = rules.map((rule, sortOrder) => ({ ...rule, sortOrder }));
  validateRuleSet(ordered);
  if (options && snapshot.options)
    validateReferences(snapshot.options, options, ordered);
  if (options && changedRules) options.customRules = ordered;
  return {
    rules: changedRules ? ordered : undefined,
    options:
      options && (changedRules || changedOptions)
        ? outputProfileOptionsSchema.parse(options)
        : undefined,
  };
}

export class McpConfiguration {
  private readonly repository: OutputRepository;
  private readonly profiles: OutputProfileService;
  private readonly rules: RuleService;
  private readonly plans = new Map<string, Plan>();

  constructor(private readonly database: DatabaseConnection) {
    this.repository = new OutputRepository(database);
    this.profiles = new OutputProfileService(this.repository);
    this.rules = new RuleService(new RuleRepository(database));
  }

  listProfiles() {
    return this.repository
      .listProfiles()
      .map(({ id, name, targetClient, enabled, optionsJson }) => {
        const options = outputProfileOptionsSchema.parse(
          JSON.parse(optionsJson),
        );
        return {
          id,
          name,
          targetClient,
          enabled,
          rulesMode: options.customRules == null ? "global" : "custom",
        };
      });
  }

  readRules(profileId?: string) {
    return this.readSnapshot(profileId).rules;
  }

  listGroups(profileId: string) {
    return this.profileOptions(profileId).proxyGroups.map(groupSummary);
  }

  listProviders(profileId: string) {
    return Object.entries(this.profileOptions(profileId).ruleProviders).map(
      ([name, provider]) => providerSummary(name, provider),
    );
  }

  listSources() {
    return this.repository
      .listSources()
      .map(({ id, name, type, enabled, lastFetchStatus }) => ({
        id,
        name,
        type,
        enabled,
        lastFetchStatus,
      }));
  }

  checkOutput(profileId: string) {
    const result = new OutputAvailabilityService(this.repository).check(
      profileId,
    );
    if (!result)
      throw new RuleValidationError("Unknown output profile: " + profileId);
    return result;
  }

  plan({ profileId, operations }: z.infer<typeof planSchema>) {
    const snapshot = this.database.sqlite.transaction(() =>
      this.readSnapshot(profileId),
    )();
    const result = applyToDraft(snapshot, operations);
    if (!result.rules && !result.options)
      throw new RuleValidationError("No configuration changes");
    const planId = randomUUID();
    const expiresAt = Date.now() + planLifetime;
    for (const [key, plan] of this.plans)
      if (plan.expiresAt <= Date.now()) this.plans.delete(key);
    if (this.plans.size >= 20)
      this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(planId, {
      ...result,
      profileId,
      revision: revisionOf(snapshot),
      expiresAt,
      operationCount: operations.length,
    });
    return {
      planId,
      expiresAt: new Date(expiresAt).toISOString(),
      profileId: profileId ?? null,
      changes: operations.map(review),
      ruleCount: {
        before: snapshot.rules.length,
        after: result.rules?.length ?? snapshot.rules.length,
      },
      switchesToCustomRules: Boolean(
        profileId && result.rules && snapshot.options?.customRules == null,
      ),
    };
  }

  apply(planId: string) {
    const plan = this.plans.get(planId);
    if (!plan || plan.expiresAt <= Date.now()) {
      this.plans.delete(planId);
      throw new RuleValidationError(
        "Unknown or expired plan. Preview the changes again.",
      );
    }
    const result = this.database.sqlite
      .transaction(() => {
        const current = this.readSnapshot(plan.profileId);
        if (plan.revision !== revisionOf(current)) {
          throw new RuleValidationError(
            "Configuration changed after preview. Create a new plan.",
          );
        }
        if (plan.profileId && plan.options) {
          this.profiles.update(plan.profileId, { options: plan.options }, "");
        } else if (plan.rules) {
          this.rules.replaceAll({ rules: plan.rules });
        }
        new OperationLogService(this.database).record({
          action: "mcp.apply-configuration",
          message: "Applied reviewed MCP configuration changes",
          metadata: { profileId: plan.profileId, count: plan.operationCount },
        });
        return {
          applied: true,
          profileId: plan.profileId ?? null,
          count: plan.operationCount,
        };
      })
      .immediate();
    this.plans.delete(planId);
    return result;
  }

  private profileOptions(profileId: string) {
    const profile = this.repository.findProfile(profileId);
    if (!profile)
      throw new RuleValidationError("Unknown output profile: " + profileId);
    return outputProfileOptionsSchema.parse(JSON.parse(profile.optionsJson));
  }

  private globalRules() {
    return this.rules.list().map((rule) => userRuleSchema.parse(rule));
  }

  private readSnapshot(profileId?: string): Snapshot {
    if (!profileId) return { rules: this.globalRules() };
    const profile = this.repository.findProfile(profileId);
    if (!profile)
      throw new RuleValidationError("Unknown output profile: " + profileId);
    const { id, optionsJson, targetClient } = profile;
    const options = outputProfileOptionsSchema.parse(JSON.parse(optionsJson));
    return {
      profile: { id, optionsJson, targetClient },
      options,
      rules: options.customRules ?? this.globalRules(),
    };
  }
}
