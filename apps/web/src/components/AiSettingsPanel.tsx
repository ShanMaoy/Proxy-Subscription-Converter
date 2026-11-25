import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiConnectionTestResult,
  AiSettings,
  GeoDatasetStatus,
  GeoDatasetSync,
} from "@subscription-converter/shared";
import { useState, type FormEvent } from "react";
import { apiRequest } from "../lib/api";
import { ErrorBanner } from "./ErrorBanner";

type SettingsResponse = AiSettings & { datasets: GeoDatasetStatus[] };
const settingsKey = ["system", "ai"] as const;

export function AiSettingsPanel() {
  const client = useQueryClient();
  const [baseUrl, setBaseUrl] = useState<string>();
  const [model, setModel] = useState<string>();
  const [apiKey, setApiKey] = useState("");
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: () => apiRequest<SettingsResponse>("/api/system/ai"),
    refetchInterval: 60_000,
  });
  const save = useMutation({
    mutationFn: ({
      method,
      payload,
    }: {
      method: "PUT" | "DELETE";
      payload?: string;
    }) =>
      apiRequest<SettingsResponse>("/api/system/ai", { method, body: payload }),
    onSuccess: (data) => {
      client.setQueryData(settingsKey, data);
      setApiKey("");
      setBaseUrl(undefined);
      setModel(undefined);
    },
  });
  const actualBase = baseUrl ?? settings.data?.baseUrl ?? "";
  const sync = useMutation({
    mutationFn: () =>
      apiRequest<GeoDatasetSync>("/api/system/ai/datasets/sync", {
        method: "POST",
      }),
    onSuccess: (data) => {
      client.setQueryData<SettingsResponse>(settingsKey, (current) =>
        current ? { ...current, datasets: data.datasets } : current,
      );
    },
  });
  const actualModel = model ?? settings.data?.model ?? "";
  const formPayload = () =>
    JSON.stringify({
      baseUrl: actualBase,
      model: actualModel,
      apiKey: apiKey.trim() || undefined,
    });
  const test = useMutation({
    mutationFn: () =>
      apiRequest<AiConnectionTestResult>("/api/system/ai/test", {
        method: "POST",
        body: formPayload(),
      }),
  });
  const busy = settings.isPending || save.isPending || test.isPending;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy) save.mutate({ method: "PUT", payload: formPayload() });
  };

  return (
    <section
      className="panel ai-settings-panel"
      aria-labelledby="ai-settings-title"
    >
      <h2 id="ai-settings-title">规则 AI 助手设置</h2>
      <ErrorBanner error={settings.error ?? save.error} />
      {save.isSuccess && <p role="status">AI 设置已更新。</p>}
      <form className="form-stack" onSubmit={submit}>
        <div className="form-grid">
          <label>
            API 地址
            <input
              type="url"
              required
              maxLength={500}
              placeholder="https://api.openai.com/v1"
              value={actualBase}
              disabled={test.isPending}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                test.reset();
              }}
            />
          </label>
          <label>
            模型名称
            <input
              required
              maxLength={150}
              placeholder="填写服务商提供的模型 ID"
              value={actualModel}
              disabled={test.isPending}
              onChange={(event) => {
                setModel(event.target.value);
                test.reset();
              }}
            />
          </label>
        </div>
        <label>
          API Key
          <input
            type="password"
            maxLength={4096}
            autoComplete="off"
            value={apiKey}
            disabled={test.isPending}
            onChange={(event) => {
              setApiKey(event.target.value);
              test.reset();
            }}
            required={!settings.data?.hasApiKey}
            placeholder={
              settings.data?.hasApiKey
                ? "已加密保存，留空可保留原密钥"
                : "输入服务商的 API Key"
            }
          />
        </label>
        <p className="field-help">
          支持 OpenAI 兼容的 Chat Completions 接口，模型需支持 JSON 输出。
        </p>
        <div className="assistant-settings-actions">
          <button type="submit" className="primary-button" disabled={busy}>
            保存 AI 设置
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={(event) => {
              if (event.currentTarget.form?.reportValidity()) test.mutate();
            }}
          >
            {test.isPending ? "正在测试…" : "测试 API"}
          </button>
          {settings.data?.hasApiKey && (
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm("确定移除已保存的 AI API Key 和服务配置？")
                ) {
                  test.reset();
                  save.mutate({ method: "DELETE" });
                }
              }}
            >
              移除 AI 配置
            </button>
          )}
        </div>
        <ErrorBanner error={test.error} />
        {test.data && (
          <div
            className={`alert ${test.data.passed ? "success" : "error"}`}
            role="status"
          >
            {test.data.passed
              ? `测试通过，${test.data.model} 已返回有效 JSON（${test.data.elapsedMs} 毫秒）。`
              : `测试失败：${test.data.message}`}
          </div>
        )}
      </form>
      <div className="geo-catalog">
        <div className="geo-catalog-heading">
          <h3>GeoIP / GeoSite 数据库</h3>
          <button
            type="button"
            className="secondary-button"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {sync.isPending ? "正在同步…" : "立即同步"}
          </button>
        </div>
        <ErrorBanner error={sync.error} />
        {sync.data && (
          <p role="status">
            已同步 {sync.data.updated} 个分类
            {sync.data.failed
              ? `，${sync.data.failed} 个分类同步失败，已有缓存会保留`
              : ""}
            。
          </p>
        )}
        <p className="field-help">
          MetaCubeX
          数据每天自动更新。查询遇到新分类时会按需缓存，更新失败时继续使用已有数据。
        </p>
        <ul>
          {settings.data?.datasets.map(({ kind, category, updatedAt }) => (
            <li key={kind + category}>
              <strong>
                {kind.toUpperCase()} · {category}
              </strong>
              <span>
                {updatedAt
                  ? new Date(updatedAt).toLocaleString("zh-CN")
                  : "等待同步"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
