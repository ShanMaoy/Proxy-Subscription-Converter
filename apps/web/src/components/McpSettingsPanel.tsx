import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCopy, KeyRound } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "../lib/api";
import { ErrorBanner } from "./ErrorBanner";

type McpAccess = {
  endpoint: string | null;
  hasApiKey: boolean;
  createdAt: string | null;
};

const key = ["system", "mcp"] as const;
const path = "/api/system/mcp";

export function McpSettingsPanel() {
  const client = useQueryClient();
  const [apiKey, setApiKey] = useState<string>();
  const [feedback, setFeedback] = useState("");
  const access = useQuery({
    queryKey: key,
    queryFn: () => apiRequest<McpAccess>(path),
  });
  const rotate = useMutation({
    mutationFn: async () => {
      const { apiKey: created, ...status } = await apiRequest<
        McpAccess & { apiKey: string }
      >(path, { method: "POST" });
      setApiKey(created);
      return status;
    },
    onSuccess: (status) => client.setQueryData(key, status),
  });
  const revoke = useMutation({
    mutationFn: () => apiRequest<void>(path, { method: "DELETE" }),
    onSuccess: () => {
      setApiKey(undefined);
      setFeedback("");
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const endpoint =
    access.data?.endpoint ?? new URL("/mcp", window.location.origin).href;
  const pending = access.isPending || rotate.isPending || revoke.isPending;
  function clientConfig(token: string) {
    return JSON.stringify(
      {
        mcpServers: {
          substation: {
            type: "http",
            url: endpoint,
            headers: { Authorization: "Bearer " + token },
          },
        },
      },
      null,
      2,
    );
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback(label + "已复制");
    } catch {
      setFeedback("无法访问剪贴板，请手动复制。");
    }
  }

  return (
    <section
      className="panel mcp-settings-panel"
      aria-labelledby="mcp-settings-title"
    >
      <header className="section-heading">
        <KeyRound size={20} />
        <h2 id="mcp-settings-title">MCP 接入</h2>
      </header>
      <ErrorBanner error={access.error ?? rotate.error ?? revoke.error} />
      <p>
        API Key 默认有配置修改权限。先用 <code>plan_configuration</code>{" "}
        预览，再通过 <code>apply_configuration</code> 应用。
      </p>
      <div className="url-copy-row">
        <code>{endpoint}</code>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void copy(endpoint, "端点地址")}
        >
          <ClipboardCopy size={16} /> 复制地址
        </button>
      </div>
      <div className="mcp-key-actions">
        <button
          type="button"
          className="primary-button"
          disabled={pending || !access.data}
          onClick={() => {
            if (
              !access.data?.hasApiKey ||
              window.confirm(
                "轮换后，旧密钥和已连接的 MCP 会话会失效。继续吗？",
              )
            ) {
              setFeedback("");
              rotate.mutate();
            }
          }}
        >
          {access.data?.hasApiKey ? "轮换 API Key" : "生成 API Key"}
        </button>
        {access.data?.hasApiKey && (
          <button
            type="button"
            className="danger-button"
            disabled={pending}
            onClick={() => {
              if (
                window.confirm(
                  "撤销后，当前密钥和已连接的 MCP 会话会失效。继续吗？",
                )
              )
                revoke.mutate();
            }}
          >
            撤销密钥
          </button>
        )}
      </div>
      {apiKey && (
        <div className="sensitive-note">
          <label>
            <span>新密钥仅显示这一次</span>
            <input
              className="mcp-key-value"
              readOnly
              value={apiKey}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        </div>
      )}
      <ol className="mcp-steps">
        <li>在 MCP 客户端添加远程服务器，传输类型选择 Streamable HTTP。</li>
        <li>
          填入上方端点，添加 <code>Authorization: Bearer &lt;API Key&gt;</code>{" "}
          请求头。
        </li>
        <li>
          连接后调用 <code>list_output_profiles</code> 查看可管理的输出。
        </li>
      </ol>
      <details>
        <summary>客户端 JSON 配置示例</summary>
        <pre>{clientConfig("<API Key>")}</pre>
      </details>
      <button
        type="button"
        className="secondary-button"
        onClick={() =>
          void copy(clientConfig(apiKey ?? "<API Key>"), "接入配置")
        }
      >
        <ClipboardCopy size={16} /> {apiKey ? "复制配置与密钥" : "复制配置模板"}
      </button>
      {feedback && <p role="status">{feedback}</p>}
    </section>
  );
}
