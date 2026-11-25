import { afterEach, describe, expect, it, vi } from "vitest";
import { userRuleSchema, type UserRule } from "@subscription-converter/shared";
import { loadConfig } from "../config/env";
import { initializeDatabase, type DatabaseConnection } from "../db/database";
import {
  RemoteFetchError,
  type postToPublicHttps,
} from "../remote/fetch-subscription";
import { BackupService } from "../system/backup-service";
import { AiSettingsStore } from "./ai-settings";
import { GeoDatasets } from "./geo-datasets";
import { RuleAssistant } from "./rule-assistant";
import { checkRuleCoverage } from "./rule-coverage";

const databases: DatabaseConnection[] = [];
const config = loadConfig({
  NODE_ENV: "test",
  SESSION_SECRET: "fixture-secret-longer-than-thirty-two-characters",
});
const time = "2026-11-25T00:00:00.000Z";
const baseSettings = {
  baseUrl: "https://provider.example.com/v1",
  model: "fixture",
  apiKey: "test-assistant-key",
};

function setup() {
  const database = initializeDatabase(":memory:");
  databases.push(database);
  return { database, settings: new AiSettingsStore(database, config) };
}

function rule(input: Partial<UserRule>): UserRule {
  return userRuleSchema.parse({
    id: "fallback",
    ruleType: "MATCH",
    value: null,
    policy: "DIRECT",
    enabled: true,
    sortOrder: 0,
    note: null,
    createdAt: time,
    updatedAt: time,
    ...input,
  });
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("rule assistant", () => {
  it("tests draft credentials without saving or sending any rule data", async () => {
    const { database, settings } = setup();
    const geo = new GeoDatasets(database);
    const post = vi.fn<typeof postToPublicHttps>(async () =>
      JSON.stringify({
        choices: [{ message: { content: '{"answer":"OK","changes":[]}' } }],
      }),
    );
    const assistant = new RuleAssistant(settings, geo, post);
    const check = await assistant.testConnection(baseSettings);

    expect(check).toMatchObject({ passed: true, model: baseSettings.model });
    expect(settings.status().hasApiKey).toBe(false);
    const [url, headers, body] = post.mock.calls[0];
    expect(url.href).toBe("https://provider.example.com/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer " + baseSettings.apiKey);
    expect(JSON.parse(body)).toMatchObject({
      model: baseSettings.model,
      messages: [{ role: "user" }],
      response_format: { type: "json_object" },
    });
    expect(body).not.toContain("rules");
  });

  it("reuses a saved key only for the same endpoint and reports provider failures", async () => {
    const { database, settings } = setup();
    settings.save(baseSettings);
    const post = vi
      .fn<typeof postToPublicHttps>()
      .mockRejectedValueOnce(new RemoteFetchError("AI 服务返回 HTTP 401", 502))
      .mockResolvedValueOnce(
        '{"choices":[{"message":{"content":"just text"}}]}',
      );
    const assistant = new RuleAssistant(
      settings,
      new GeoDatasets(database),
      post,
    );

    await expect(
      assistant.testConnection({
        baseUrl: "https://other.example.com/v1",
        model: "fixture",
      }),
    ).rejects.toThrow(/API Key/);
    expect(post).not.toHaveBeenCalled();

    const draft = { baseUrl: baseSettings.baseUrl + "/", model: "new-model" };
    expect(await assistant.testConnection(draft)).toEqual({
      passed: false,
      message: "AI 服务返回 HTTP 401",
    });
    expect(post.mock.calls[0][1].authorization).toBe(
      "Bearer " + baseSettings.apiKey,
    );
    expect(await assistant.testConnection(draft)).toMatchObject({
      passed: false,
      message: expect.stringContaining("JSON"),
    });
    expect(settings.credentials()).toEqual(baseSettings);
  });

  it("persists settings with an encrypted write-only key excluded from backups", () => {
    const { database, settings } = setup();
    expect(settings.save(baseSettings)).toEqual({
      baseUrl: baseSettings.baseUrl,
      model: baseSettings.model,
      hasApiKey: true,
    });
    const encrypted = database.sqlite
      .prepare("SELECT api_key_encrypted FROM ai_assistant_settings")
      .get();
    expect(JSON.stringify(encrypted)).not.toContain(baseSettings.apiKey);
    expect(new AiSettingsStore(database, config).credentials()).toEqual(
      baseSettings,
    );
    expect(
      JSON.stringify(new BackupService(database, config).export()),
    ).not.toContain("provider.example.com");
    expect(() =>
      settings.save({
        baseUrl: "https://different.example.com/v1",
        model: "fixture",
      }),
    ).toThrow(/API Key/);
    expect(settings.clear().hasApiKey).toBe(false);
  });

  it("matches domains and IPs against enabled Geo rules and reuses the downloaded data", async () => {
    const { database } = setup();
    const download = vi.fn(async (url: string) =>
      url.includes("/geoip/")
        ? "1.0.1.0/24\n2001:db8::/32\n"
        : "+.huya.com\nexact.example",
    );
    const geo = new GeoDatasets(database, download);
    const domainRules = [rule({ id: "cn", ruleType: "GEOSITE", value: "cn" })];
    const result = await checkRuleCoverage(
      "https://www.huya.com/example",
      domainRules,
      geo,
    );
    expect(result.matches).toMatchObject([{ id: "cn", policy: "DIRECT" }]);
    await checkRuleCoverage("huya.com", domainRules, geo);
    expect(download).toHaveBeenCalledTimes(1);
    const ipRules = [
      rule({ id: "ip", ruleType: "GEOIP", value: "CN", noResolve: true }),
    ];
    expect(
      (await checkRuleCoverage("1.0.1.5", ipRules, geo)).matches,
    ).toHaveLength(1);
    expect(
      (await checkRuleCoverage("2001:db8::10", ipRules, geo)).matches,
    ).toHaveLength(1);
    expect(
      (await checkRuleCoverage("huya.com", ipRules, geo)).unchecked,
    ).toEqual(["GEOIP,CN 使用 no-resolve，仅核对直接提交的 IP"]);
  });

  it("keeps the last valid dataset when a scheduled refresh returns invalid data", async () => {
    const { database } = setup();
    const download = vi
      .fn()
      .mockResolvedValueOnce("+.huya.com")
      .mockResolvedValueOnce("<html>Unavailable</html>");
    const geo = new GeoDatasets(database, download);
    expect((await geo.get("geosite", "cn"))?.matches("huya.com")).toBe(true);
    database.sqlite.exec("UPDATE geo_datasets SET updated_at = 1");
    const cached = await geo.get("geosite", "cn");
    expect(cached?.matches("huya.com")).toBe(true);
    expect(cached?.stale).toBe(true);
  });

  it("refreshes the common Geo categories after one day while the service runs", async () => {
    vi.useFakeTimers();
    const { database } = setup();
    const download = vi.fn(async (url: string) =>
      url.includes("/geoip/") ? "1.0.1.0/24" : "+.huya.com",
    );
    const geo = new GeoDatasets(database, download);
    try {
      geo.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(download).toHaveBeenCalledTimes(5);
      expect(geo.status().every((dataset) => dataset.updatedAt)).toBe(true);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(download).toHaveBeenCalledTimes(10);
    } finally {
      await geo.stop();
      vi.useRealTimers();
    }
  });

  it("can immediately resync fresh entries and retains previous data on partial failures", async () => {
    const { database } = setup();
    let fail = false;
    const download = vi.fn(async (url: string) => {
      if (fail && url.includes("/geosite/cn.")) throw new Error("Unavailable");
      return url.includes("/geoip/") ? "1.0.1.0/24" : "+.huya.com";
    });
    const geo = new GeoDatasets(database, download);
    expect(await geo.sync()).toMatchObject({ updated: 5, failed: 0 });
    fail = true;
    const resync = geo.sync();
    expect(geo.sync()).toBe(resync);
    expect(await resync).toMatchObject({ updated: 4, failed: 1 });
    expect(download).toHaveBeenCalledTimes(10);
    expect((await geo.get("geosite", "cn"))?.matches("huya.com")).toBe(true);
  });

  it("understands a Chinese website name and keeps its context in follow-up messages", async () => {
    const { database, settings } = setup();
    const geo = new GeoDatasets(database, async () => "+.huya.com");
    const post = vi.fn<typeof postToPublicHttps>(async () =>
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                answer: "可以改为直连。",
                changes: [],
              }),
            },
          },
        ],
      }),
    );
    const assistant = new RuleAssistant(settings, geo, post);
    const context = {
      rules: [
        rule({ id: "cn", ruleType: "GEOSITE", value: "CN", policy: "PROXY" }),
      ],
      policies: ["DIRECT", "PROXY"],
      ruleProviders: [],
    };
    const question = "最近访问虎牙有点卡，感觉走了代理";
    const first = await assistant.suggest({ ...context, prompt: question });
    expect(first.coverage).toMatchObject({
      target: "huya.com",
      matches: [{ policy: "PROXY" }],
    });
    expect(first.answer).toContain("实际出站以客户端连接日志为准");
    expect(post).not.toHaveBeenCalled();

    settings.save(baseSettings);
    const next = await assistant.suggest({
      ...context,
      prompt: "可以改成直连吗",
      history: [{ question, answer: first.answer }],
    });
    expect(next.coverage?.target).toBe("huya.com");
    const modelRequest = JSON.parse(post.mock.calls[0][2]);
    expect(JSON.parse(modelRequest.messages[1].content).history).toMatchObject([
      { question },
    ]);
  });

  it("returns a reviewable draft and never writes AI suggestions to the rules table", async () => {
    const { database, settings } = setup();
    settings.save(baseSettings);
    const post = vi.fn<typeof postToPublicHttps>(async () =>
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                answer: "建议把域名放在兜底规则前。",
                changes: [
                  {
                    op: "add",
                    rule: {
                      ruleType: "DOMAIN-SUFFIX",
                      value: "huya.com",
                      policy: "DIRECT",
                    },
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
    const geo = new GeoDatasets(database, async () => "+.huya.com");
    const assistant = new RuleAssistant(settings, geo, post);
    const result = await assistant.suggest({
      prompt: "为虎牙添加规则",
      target: "huya.com",
      rules: [rule({ note: "private fixture note" })],
      policies: ["DIRECT"],
      ruleProviders: [],
    });
    expect(result.proposal?.map((row) => row.ruleType)).toEqual([
      "DOMAIN-SUFFIX",
      "MATCH",
    ]);
    expect(result.changes).toHaveLength(1);
    expect(post.mock.calls[0][0].href).toBe(
      "https://provider.example.com/v1/chat/completions",
    );
    expect(post.mock.calls[0][2]).not.toContain("private fixture note");
    expect(
      database.sqlite.prepare("SELECT count(*) AS total FROM rules").get(),
    ).toEqual({ total: 0 });
  });
});
