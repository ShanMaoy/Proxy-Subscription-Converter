import { BlockList, isIP } from "node:net";
import type {
  GeoDatasetStatus,
  GeoDatasetSync,
} from "@subscription-converter/shared";
import type { DatabaseConnection } from "../db/database";
import { readLimitedBody } from "../remote/fetch-subscription";

type Kind = GeoDatasetStatus["kind"];
type Dataset = { kind: Kind; category: string };
type StoredDataset = { content: string; updatedAt: number };
type GeoIndex = {
  matches: (value: string) => boolean;
  partial: boolean;
};

const catalogRoot =
  "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/";
const day = 86_400_000;
const retryDelay = 15 * 60_000;
const defaults: Dataset[] = [
  { kind: "geosite", category: "cn" },
  { kind: "geosite", category: "category-ads-all" },
  { kind: "geosite", category: "private" },
  { kind: "geoip", category: "cn" },
  { kind: "geoip", category: "private" },
];

export class GeoDatasets {
  private readonly loading = new Map<
    string,
    Promise<StoredDataset | undefined>
  >();
  private readonly failures = new Map<string, number>();
  private readonly indexes = new Map<
    string,
    { updatedAt: number; index: GeoIndex }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private refresh?: Promise<void>;
  private manualRefresh?: Promise<GeoDatasetSync>;
  private stopping = false;

  constructor(
    private readonly database: DatabaseConnection,
    private readonly fetchList = async (url: string) => {
      // The URL is constructed from the fixed HTTPS catalog and a validated category.
      const signal = AbortSignal.timeout(10_000);
      const response = await fetch(url, { redirect: "error", signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Geo dataset download failed");
      }
      return readLimitedBody(response, 5 * 1024 * 1024, signal);
    },
  ) {}

  status(): GeoDatasetStatus[] {
    return this.list().map(({ updatedAt, ...dataset }) => ({
      ...dataset,
      updatedAt: updatedAt === null ? null : new Date(updatedAt).toISOString(),
    }));
  }

  start() {
    this.timer = setInterval(() => this.schedule(), retryDelay);
    this.timer.unref();
    this.schedule();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.allSettled([this.refresh, this.manualRefresh]);
    await Promise.allSettled(this.loading.values());
  }

  sync() {
    if (!this.manualRefresh) {
      this.manualRefresh = (async () => {
        await this.refresh;
        const result = await this.refreshCatalog(true);
        return { ...result, datasets: this.status() };
      })().finally(() => {
        this.manualRefresh = undefined;
      });
    }
    return this.manualRefresh;
  }

  async get(kind: Kind, category: string) {
    const dataset = { kind, category: category.trim().toLowerCase() };
    if (!/^[\w!@-]{1,80}$/.test(dataset.category)) return undefined;
    const saved = await this.ensure(dataset);
    if (!saved) return undefined;

    const key = this.key(dataset);
    let cached = this.indexes.get(key);
    if (!cached || cached.updatedAt !== saved.updatedAt) {
      cached = {
        updatedAt: saved.updatedAt,
        index: parseDataset(kind, saved.content),
      };
      this.indexes.set(key, cached);
      if (this.indexes.size > 24)
        this.indexes.delete(this.indexes.keys().next().value!);
    }
    return { ...cached.index, stale: Date.now() - saved.updatedAt >= day };
  }

  private key(dataset: Dataset) {
    return dataset.kind + ":" + dataset.category;
  }

  private list() {
    const stored = this.database.sqlite
      .prepare<
        [],
        Dataset & { updatedAt: number }
      >("SELECT kind, category, updated_at AS updatedAt FROM geo_datasets ORDER BY kind, category")
      .all();
    const initial = defaults.map((dataset) => ({
      ...dataset,
      updatedAt: null,
    }));
    return [
      ...new Map(
        [...initial, ...stored].map((dataset) => [this.key(dataset), dataset]),
      ).values(),
    ];
  }

  private read({ kind, category }: Dataset) {
    return this.database.sqlite
      .prepare<
        [Kind, string],
        StoredDataset
      >("SELECT content, updated_at AS updatedAt FROM geo_datasets WHERE kind = ? AND category = ?")
      .get(kind, category);
  }

  private ensure(dataset: Dataset, force = false) {
    const key = this.key(dataset);
    const pending = this.loading.get(key);
    if (pending) return pending;
    const saved = this.read(dataset);
    if (
      this.stopping ||
      (!force &&
        ((saved && Date.now() - saved.updatedAt < day) ||
          (this.failures.get(key) ?? 0) > Date.now()))
    ) {
      return Promise.resolve(saved);
    }
    const load = this.download(dataset)
      .catch(() => {
        this.failures.set(key, Date.now() + retryDelay);
        if (this.failures.size > 128)
          this.failures.delete(this.failures.keys().next().value!);
        return saved;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, load);
    return load;
  }

  private async download({ kind, category }: Dataset) {
    const content = await this.fetchList(
      catalogRoot + kind + "/" + encodeURIComponent(category) + ".list",
    );
    const index = parseDataset(kind, content);
    const updatedAt = Date.now();
    this.database.sqlite
      .prepare(
        `
      INSERT INTO geo_datasets (kind, category, content, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(kind, category)
      DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `,
      )
      .run(kind, category, content, updatedAt);
    this.failures.delete(this.key({ kind, category }));
    if (this.indexes.has(this.key({ kind, category }))) {
      this.indexes.set(this.key({ kind, category }), { updatedAt, index });
    }
    return { content, updatedAt };
  }

  private schedule() {
    if (this.refresh || this.manualRefresh || this.stopping) return;
    this.refresh = this.refreshCatalog(false)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.refresh = undefined;
      });
  }

  private async refreshCatalog(force: boolean) {
    const deadline = Date.now() - day;
    const list = this.list().filter(
      (dataset) =>
        force || dataset.updatedAt === null || dataset.updatedAt <= deadline,
    );
    let updated = 0;
    let failed = 0;
    for (let index = 0; index < list.length && !this.stopping; index += 5) {
      const batch = list.slice(index, index + 5);
      const results = await Promise.all(
        batch.map((dataset) => this.ensure(dataset, force)),
      );
      for (const [position, saved] of results.entries()) {
        if (saved && !this.failures.has(this.key(batch[position]))) updated++;
        else failed++;
      }
    }
    return { updated, failed };
  }
}

function parseDataset(kind: Kind, content: string): GeoIndex {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (kind === "geoip") {
    const ipList = new BlockList();
    let valid = 0;
    for (const line of lines) {
      const [address, prefix] = line.split("/");
      const family = isIP(address);
      if (
        !family ||
        !prefix ||
        !/^\d+$/.test(prefix) ||
        Number(prefix) > (family === 4 ? 32 : 128)
      )
        continue;
      ipList.addSubnet(address, Number(prefix), family === 6 ? "ipv6" : "ipv4");
      valid++;
    }
    if (!valid) throw new Error("Empty GeoIP dataset");
    return {
      partial: valid !== lines.length,
      matches: (value) =>
        isIP(value) !== 0 &&
        ipList.check(value, isIP(value) === 6 ? "ipv6" : "ipv4"),
    };
  }
  const exact = new Set<string>();
  const suffixes = new Set<string>();
  const subdomains = new Set<string>();
  const keywords: string[] = [];
  let valid = 0;
  for (const original of lines) {
    const line = original.toLowerCase();
    if (line.startsWith("keyword:") && line.length > 8) {
      keywords.push(line.slice(8));
    } else {
      const domain = line.replace(/^(?:\+\.|\*\.|\.|domain:|full:)/, "");
      if (!/^[a-z\d-]+(?:\.[a-z\d-]+)*$/.test(domain)) continue;
      if (line.startsWith("*.") || line.startsWith(".")) subdomains.add(domain);
      else if (line.startsWith("+.") || line.startsWith("domain:"))
        suffixes.add(domain);
      else exact.add(domain);
    }
    valid++;
  }
  if (!valid) throw new Error("Empty GeoSite dataset");
  return {
    partial: valid !== lines.length,
    matches(value) {
      if (
        exact.has(value) ||
        keywords.some((keyword) => value.includes(keyword))
      )
        return true;
      let suffix = value;
      while (suffix) {
        if (
          suffixes.has(suffix) ||
          (suffix !== value && subdomains.has(suffix))
        )
          return true;
        const dot = suffix.indexOf(".");
        suffix = dot === -1 ? "" : suffix.slice(dot + 1);
      }
      return false;
    },
  };
}
