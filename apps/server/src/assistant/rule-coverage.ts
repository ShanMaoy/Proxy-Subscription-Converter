import { lookup, Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { RuleCoverage, UserRule } from "@subscription-converter/shared";
import { RuleValidationError } from "../rules/service";
import type { GeoDatasets } from "./geo-datasets";

const geoTypes = { GEOIP: "geoip", GEOSITE: "geosite" } as const;
const supported = new Set([
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "IP-CIDR",
  "IP-CIDR6",
]);

function normalizeTarget(value: string) {
  if (isIP(value)) return value.toLowerCase();
  try {
    if (value.includes("://") && !/^https?:\/\//i.test(value)) {
      throw new Error("Unsupported URL scheme");
    }
    const url = new URL(
      /^https?:\/\//i.test(value) ? value : "https://" + value,
    );
    if (
      url.username ||
      url.password ||
      !["https:", "http:"].includes(url.protocol)
    )
      throw new Error();
    const host = url.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
    if (isIP(host) || /^[a-z\d-]+(?:\.[a-z\d-]+)*$/.test(host)) return host;
  } catch {
    // Report a field error rather than exposing URL parser details.
  }
  throw new RuleValidationError("请输入有效的域名、HTTP 地址或 IP");
}

async function resolveAddresses(host: string) {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const results = await Promise.allSettled([
    resolver.resolve4(host),
    resolver.resolve6(host),
  ]);
  const addresses = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (addresses.length) return addresses;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(host, { all: true }).then(
        (entries) => entries.map((entry) => entry.address),
        () => [],
      ),
      new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve([]), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function matchesCidr(cidr: string, addresses: string[]) {
  const [network, prefix] = cidr.split("/");
  const version = isIP(network);
  if (
    !version ||
    !prefix ||
    !/^\d+$/.test(prefix) ||
    Number(prefix) > (version === 4 ? 32 : 128)
  )
    return false;
  const list = new BlockList();
  const family = version === 6 ? "ipv6" : "ipv4";
  list.addSubnet(network, Number(prefix), family);
  return addresses.some(
    (address) => isIP(address) === version && list.check(address, family),
  );
}

export async function checkRuleCoverage(
  input: string,
  rules: UserRule[],
  datasets: GeoDatasets,
): Promise<RuleCoverage> {
  const target = normalizeTarget(input);
  const literalIp = isIP(target) !== 0;
  const enabled = rules
    .filter((rule) => rule.enabled && rule.value)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const needsAddresses = enabled.some(
    (rule) =>
      (rule.ruleType === "GEOIP" ||
        rule.ruleType === "IP-CIDR" ||
        rule.ruleType === "IP-CIDR6") &&
      !rule.noResolve,
  );
  const resolved = literalIp
    ? [target]
    : needsAddresses
      ? await resolveAddresses(target)
      : [];
  const addresses = literalIp
    ? resolved
    : resolved.filter(
        (address) => !/^(?:::ffff:)?198\.(?:18|19)\./i.test(address),
      );
  const seen = new Map<
    string,
    Promise<Awaited<ReturnType<GeoDatasets["get"]>>>
  >();
  const unchecked = new Set<string>();
  if (addresses.length !== resolved.length) {
    unchecked.add("服务端 DNS 返回了可能由代理生成的 Fake-IP，已排除这些地址");
  }
  const matches = await Promise.all(
    enabled.map(async (rule) => {
      const value = rule.value!.trim().toLowerCase();
      const geo = geoTypes[rule.ruleType as keyof typeof geoTypes];
      if (geo === "geosite" && literalIp) return;

      const ipRule =
        geo === "geoip" ||
        rule.ruleType === "IP-CIDR" ||
        rule.ruleType === "IP-CIDR6";
      if (ipRule && !literalIp && rule.noResolve) {
        unchecked.add(
          `${rule.ruleType},${rule.value} 使用 no-resolve，仅核对直接提交的 IP`,
        );
        return;
      }
      if (ipRule && !addresses.length) {
        unchecked.add("服务端 DNS 未返回可用于核对的 IP，未核对目标 IP 规则");
        return;
      }

      let reason: string | undefined;
      if (geo) {
        const key = `${geo},${value}`;
        let pending = seen.get(key);
        if (!pending && seen.size < 24) {
          pending = datasets.get(geo, value);
          seen.set(key, pending);
        }
        const dataset = await pending;
        if (!dataset) {
          unchecked.add(`${rule.ruleType},${rule.value} 的数据暂不可用`);
          return;
        }
        if (dataset.partial)
          unchecked.add(`${rule.ruleType},${rule.value} 含未支持的条目`);
        if (dataset.stale)
          unchecked.add(`${rule.ruleType},${rule.value} 使用上次更新的缓存`);
        if ((ipRule ? addresses : [target]).some(dataset.matches)) {
          reason = ipRule
            ? "目标 IP 落在该 GeoIP 集合"
            : "域名已在该 GeoSite 集合";
        }
      } else if (ipRule) {
        if (matchesCidr(value, addresses)) reason = "目标 IP 落在该网段";
      } else if (
        !literalIp &&
        ((rule.ruleType === "DOMAIN" && target === value) ||
          (rule.ruleType === "DOMAIN-SUFFIX" &&
            (target === value || target.endsWith("." + value))) ||
          (rule.ruleType === "DOMAIN-KEYWORD" && target.includes(value)))
      ) {
        reason = "已匹配当前域名规则";
      } else if (!supported.has(rule.ruleType)) {
        unchecked.add(
          `${rule.ruleType} 需要客户端上下文或独立规则集，未参与核对`,
        );
      }
      if (reason)
        return {
          id: rule.id,
          ruleType: rule.ruleType,
          value: rule.value!,
          policy: rule.policy,
          reason,
        };
    }),
  );
  return {
    target,
    matches: matches.filter((match) => match !== undefined),
    unchecked: [...unchecked].sort(),
  };
}
