import {
  aiSettingsInputSchema,
  type AiSettings,
} from "@subscription-converter/shared";
import type { AppConfig } from "../config/env";
import type { DatabaseConnection } from "../db/database";
import { RuleValidationError } from "../rules/service";
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
} from "../security/encryption";

type StoredSettings = { baseUrl: string; model: string; encryptedKey: string };

export class AiSettingsStore {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly config: AppConfig,
  ) {}

  status(): AiSettings {
    const saved = this.read();
    return {
      baseUrl: saved?.baseUrl ?? "https://api.openai.com/v1",
      model: saved?.model ?? "",
      hasApiKey: saved !== undefined,
    };
  }

  save(input: unknown) {
    const { baseUrl, model, apiKey } = this.normalize(input);
    const current = this.read();
    const encryptedKey = apiKey
      ? encryptSensitiveValue(apiKey, this.secret())
      : current?.baseUrl === baseUrl
        ? current.encryptedKey
        : undefined;
    if (!encryptedKey)
      throw new RuleValidationError("首次保存或更换服务地址时，请输入 API Key");
    this.database.sqlite
      .prepare(
        `
      INSERT INTO ai_assistant_settings (id, base_url, model, api_key_encrypted)
      VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        base_url = excluded.base_url, model = excluded.model,
        api_key_encrypted = excluded.api_key_encrypted
    `,
      )
      .run(baseUrl, model, encryptedKey);
    return this.status();
  }

  clear() {
    this.database.sqlite.exec("DELETE FROM ai_assistant_settings WHERE id = 1");
    return this.status();
  }

  credentials() {
    const saved = this.read();
    if (!saved)
      throw new RuleValidationError("请先到系统维护配置 AI API Key 和模型");
    return {
      baseUrl: saved.baseUrl,
      model: saved.model,
      apiKey: this.decryptKey(saved.encryptedKey),
    };
  }

  credentialsForTest(input: unknown) {
    const { baseUrl, model, apiKey } = this.normalize(input);
    if (apiKey) return { baseUrl, model, apiKey };
    const current = this.read();
    if (current?.baseUrl !== baseUrl) {
      throw new RuleValidationError("测试新服务地址时，请输入对应的 API Key");
    }
    return { baseUrl, model, apiKey: this.decryptKey(current.encryptedKey) };
  }

  private normalize(input: unknown) {
    const parsed = aiSettingsInputSchema.parse(input);
    const url = new URL(parsed.baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new RuleValidationError(
        "请填写不含凭据和查询参数的 HTTPS API 地址",
      );
    }
    if (parsed.apiKey && /\s/.test(parsed.apiKey)) {
      throw new RuleValidationError("API Key 不应包含空白字符");
    }
    return { ...parsed, baseUrl: url.href.replace(/\/+$/, "") };
  }

  private decryptKey(encryptedKey: string) {
    try {
      return decryptSensitiveValue(encryptedKey, this.secret());
    } catch {
      throw new RuleValidationError(
        "无法解密 AI API Key，请在系统维护中重新保存",
      );
    }
  }

  private read() {
    return this.database.sqlite
      .prepare<
        [],
        StoredSettings
      >("SELECT base_url AS baseUrl, model, api_key_encrypted AS encryptedKey FROM ai_assistant_settings WHERE id = 1")
      .get();
  }

  private secret() {
    if (!this.config.SESSION_SECRET)
      throw new RuleValidationError("请先配置服务端 SESSION_SECRET");
    return this.config.SESSION_SECRET;
  }
}
