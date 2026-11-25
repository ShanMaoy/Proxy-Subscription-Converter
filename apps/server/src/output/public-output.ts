import type { OutputRepository } from "./repository";
import type { OutputService } from "./service";

type DownloadFormat = "yaml" | "conf" | "txt";
const maxCachedBytes = 16 * 1024 * 1024;
const maxCachedOutputs = 128;

export class PublicOutput {
  private readonly contents = new Map<string, string>();
  private version = -1;
  private cachedBytes = 0;

  constructor(
    private readonly repository: OutputRepository,
    private readonly service: OutputService,
  ) {}

  download(token: string, format: DownloadFormat) {
    return this.repository.readOutputSnapshot((version) => {
      if (this.version !== version) {
        this.clear();
        this.version = version;
      }
      const profile = this.repository.findProfileByToken(token);
      const client = format === "conf" ? "shadowrocket" : "clash";
      if (!profile?.enabled || profile.targetClient !== client) return;

      const key = `${profile.id}:${format}`;
      const cached = this.contents.get(key);
      if (cached !== undefined) return cached;

      const content =
        format === "yaml"
          ? this.service.generate(profile.id)?.yaml
          : format === "conf"
            ? this.service.generateShadowrocket(profile.id)?.content
            : this.service.generateBase64(profile.id)?.content;
      if (content === undefined) return;
      const bytes = content.length * 2;
      if (bytes <= maxCachedBytes) {
        if (
          this.cachedBytes + bytes > maxCachedBytes ||
          this.contents.size >= maxCachedOutputs
        ) {
          this.clear();
        }
        this.contents.set(key, content);
        this.cachedBytes += bytes;
      }
      return content;
    });
  }

  private clear() {
    this.contents.clear();
    this.cachedBytes = 0;
  }
}
