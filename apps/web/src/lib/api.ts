const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const httpError = `HTTP ${response.status}`;
  let body: { ok: boolean; data?: T; error?: { message: string } } | null;
  try {
    body = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const responseType = response.headers.get("content-type");
    const format = responseType?.includes("text/html")
      ? "HTML"
      : "非 JSON 内容";
    throw new ApiError(`接口返回了${format}（${httpError}）`, response.status);
  }
  if (!response.ok || body?.ok !== true) {
    throw new ApiError(
      body?.error?.message ?? `Request failed with ${httpError}`,
      response.status,
    );
  }

  return body.data as T;
}
