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
