import { afterEach, describe, expect, it, vi } from "vitest";
import { userRuleSchema, type UserRule } from "@subscription-converter/shared";
import { initializeDatabase, type DatabaseConnection } from "../db/database";
import { GeoDatasets } from "./geo-datasets";
import { checkRuleCoverage } from "./rule-coverage";

const databases: DatabaseConnection[] = [];
const time = "2026-11-25T00:00:00.000Z";

function setup() {
  const database = initializeDatabase(":memory:");
  databases.push(database);
  return { database };
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

describe("rule coverage", () => {
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
});
