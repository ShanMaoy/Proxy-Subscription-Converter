import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

import { createPinnedLookup, isBlockedAddress } from "./safe-address";
export { isBlockedAddress } from "./safe-address";

export class RemoteFetchError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
    this.name = "RemoteFetchError";
  }
}

export type SubscriptionUserInfo = {
  upload: number | null;
  download: number | null;
  total: number | null;
  expireAt: Date | null;
};
export type RemoteFetchResult = {
  content: string;
  subscriptionUserInfo: SubscriptionUserInfo | null;
};
export type RemoteFetcher = (
  url: string,
  options?: FetchRemoteOptions,
) => Promise<string | RemoteFetchResult>;
export type FetchRemoteOptions = {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  maxRedirects?: number;
  resolveHost?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
};

async function defaultResolveHost(hostname: string) {
  return (await lookup(hostname, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function validateUrl(
  value: string,
  resolveHost: (hostname: string) => Promise<string[]>,
  signal: AbortSignal,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteFetchError("Remote subscription URL is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new RemoteFetchError("Only HTTP and HTTPS URLs are allowed");
  }
  if (url.username || url.password) {
    throw new RemoteFetchError("URL credentials are not allowed");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    ["localhost", "localhost.localdomain"].includes(
      hostname.toLowerCase().replace(/\.$/, ""),
    )
  ) {
    throw new RemoteFetchError("Local addresses are not allowed");
  }
  const addresses = isIP(hostname)
    ? [hostname]
    : await abortable(resolveHost(hostname), signal);
  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw new RemoteFetchError("Private or local addresses are not allowed");
  }
  return { url, hostname, addresses };
}

export async function readLimitedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let content = "";
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes)
        throw new RemoteFetchError(
          "Remote response exceeds the size limit",
          413,
        );
      content += decoder.decode(value, { stream: true });
    }
    return content + decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function postToPublicHttps(
  endpoint: URL,
  headers: Record<string, string>,
  body: string,
) {
  if (endpoint.protocol !== "https:") {
    throw new RemoteFetchError("AI 接口必须使用 HTTPS");
  }
  const signal = AbortSignal.timeout(45_000);
  let dispatcher: Agent | undefined;
  try {
    // The fixed default API origin also works with system proxies that use fake IPs.
    // Configured third-party destinations still require validated, pinned DNS.
    if (endpoint.href !== "https://api.openai.com/v1/chat/completions") {
      const { hostname, addresses } = await validateUrl(
        endpoint.href,
        defaultResolveHost,
        signal,
      );
      const pinnedLookup = createPinnedLookup(hostname, addresses);
      dispatcher = new Agent({
        // Give each verified address time to connect before trying another family.
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 1_500,
        connect: {
          lookup(host, options, callback) {
            setImmediate(() => pinnedLookup(host, options, callback));
          },
        },
      });
    }
    const init = {
      method: "POST",
      headers,
      body,
      signal,
      redirect: "error" as const,
      dispatcher: dispatcher as unknown as RequestInit["dispatcher"],
    };
    const response = await fetch(endpoint, init);
    if (!response.ok) {
      await response.body?.cancel();
      throw new RemoteFetchError(`AI 服务返回 HTTP ${response.status}`, 502);
    }
    return await readLimitedBody(response, 1024 * 1024, signal);
  } catch (error) {
    if (signal.aborted) throw new RemoteFetchError("AI 服务响应超时", 504);
    if (error instanceof RemoteFetchError) throw error;
    throw new RemoteFetchError("无法连接 AI 服务，请核对接口地址", 502);
  } finally {
    await dispatcher?.destroy();
  }
}

export function parseSubscriptionUserInfo(
  value: string | null,
): SubscriptionUserInfo | null {
  if (!value) return null;
  const fields = Object.fromEntries(
    value
      .split(";")
      .map((segment) => segment.trim().split("=", 2))
      .filter(([key, fieldValue]) => key && fieldValue),
  );
  const numberField = (key: string) => {
    const value = fields[key]?.trim();
    if (!value || !/^\d+$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  };
  const expire = numberField("expire");
  const date = expire ? new Date(expire * 1000) : null;
  return {
    upload: numberField("upload"),
    download: numberField("download"),
    total: numberField("total"),
    expireAt: date && Number.isFinite(date.getTime()) ? date : null,
  };
}

export async function fetchRemoteSubscription(
  initialUrl: string,
  options: FetchRemoteOptions = {},
): Promise<RemoteFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 10_000,
  );
  let currentUrl = initialUrl;
  try {
    for (
      let redirectCount = 0;
      redirectCount <= maxRedirects;
      redirectCount++
    ) {
      const { url, hostname, addresses } = await validateUrl(
        currentUrl,
        resolveHost,
        controller.signal,
      );
      const dispatcher = new Agent({
        connect: { lookup: createPinnedLookup(hostname, addresses) },
      });
      let response: Response | undefined;
      try {
        const init = {
          dispatcher: dispatcher as unknown as RequestInit["dispatcher"],
          redirect: "manual" as const,
          signal: controller.signal,
          headers: {
            "user-agent": "subscription-converter/0.1",
            accept: "text/yaml,text/plain,application/yaml,*/*;q=0.1",
          },
        };
        response = await abortable(fetchImpl(url, init), controller.signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location || redirectCount === maxRedirects)
            throw new RemoteFetchError("Remote redirect limit exceeded", 502);
          currentUrl = new URL(location, url).toString();
          continue;
        }
        if (!response.ok)
          throw new RemoteFetchError(
            `Remote server returned HTTP ${response.status}`,
            502,
          );
        if (Number(response.headers.get("content-length") ?? 0) > maxBytes)
          throw new RemoteFetchError(
            "Remote response exceeds the size limit",
            413,
          );
        return {
          content: await readLimitedBody(response, maxBytes, controller.signal),
          subscriptionUserInfo: parseSubscriptionUserInfo(
            response.headers.get("subscription-userinfo"),
          ),
        };
      } finally {
        if (response?.body && !response.body.locked)
          void response.body.cancel().catch(() => {});
        await dispatcher.destroy();
      }
    }
    throw new RemoteFetchError("Remote redirect limit exceeded", 502);
  } catch (error) {
    if (controller.signal.aborted)
      throw new RemoteFetchError("Remote subscription request timed out", 504);
    if (error instanceof RemoteFetchError) throw error;
    throw new RemoteFetchError("Remote subscription request failed", 502);
  } finally {
    clearTimeout(timer);
  }
}
