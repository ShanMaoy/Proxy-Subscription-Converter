import { z } from "zod";

import {
  createUserRuleSchema,
  updateUserRuleSchema,
  userRuleSchema,
} from "./schemas";

export const aiSettingsInputSchema = z.object({
  baseUrl: z.string().trim().max(500).url(),
  model: z.string().trim().min(1).max(150),
  apiKey: z.string().trim().min(1).max(4096).optional(),
});

const ruleCoverageInputSchema = z.object({
  target: z.string().trim().min(1).max(253),
  rules: userRuleSchema.array().max(10_000),
});

export const ruleAssistantInputSchema = ruleCoverageInputSchema.extend({
  target: z.string().trim().max(253).optional(),
  prompt: z.string().trim().min(1).max(4000),
  policies: z.string().min(1).max(150).array().max(1000),
  ruleProviders: z.string().min(1).max(150).array().max(1000),
  history: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(4000),
        answer: z.string().trim().min(1).max(6000),
      }),
    )
    .max(4)
    .default([]),
  scope: z.string().trim().min(1).max(180).optional(),
});

const ruleId = z.string().min(1).max(200);
const beforeId = ruleId.nullable().optional();
const ruleChanges = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), rule: createUserRuleSchema, beforeId }),
  z.object({ op: z.literal("update"), id: ruleId, rule: updateUserRuleSchema }),
  z.object({ op: z.literal("remove"), id: ruleId }),
  z.object({ op: z.literal("move"), id: ruleId, beforeId }),
]);

export const ruleAssistantAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(6000),
  changes: ruleChanges.array().max(40),
});

export type AiSettings = {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
};

export type AiConnectionTestResult =
  | { passed: true; model: string; elapsedMs: number }
  | { passed: false; message: string };

export type GeoDatasetStatus = {
  kind: "geoip" | "geosite";
  category: string;
  updatedAt: string | null;
};

export type GeoDatasetSync = {
  updated: number;
  failed: number;
  datasets: GeoDatasetStatus[];
};

export type RuleCoverage = {
  target: string;
  matches: {
    id: string;
    ruleType: string;
    value: string;
    policy: string;
    reason: string;
  }[];
  unchecked: string[];
};

export type RuleAssistantResponse = {
  answer: string;
  coverage: RuleCoverage | null;
  proposal: z.infer<typeof userRuleSchema>[] | null;
  changes: string[];
};
