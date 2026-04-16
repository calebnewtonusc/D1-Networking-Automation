import { loadLinkedInConfig } from "./config.js";

const VOYAGER_BASE = "https://www.linkedin.com/voyager/api";
const LINKEDIN_BASE = "https://www.linkedin.com";
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30_000;
const MIN_REQUEST_GAP_MS = 2_000;

function randomDelay(): Promise<void> {
  const ms = 2000 + Math.random() * 3000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function generateTrackingId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

export interface LinkedInAuth {
  liAt: string;
  jsessionid: string;
}

export interface LinkedInClient {
  request<T = unknown>(options: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    baseRequest?: boolean;
  }): Promise<T>;
  get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<T>;
  post<T = unknown>(
    path: string,
    body?: unknown,
    query?: Record<string, unknown>,
  ): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(
    path: string,
    query?: Record<string, unknown>,
  ): Promise<T>;
}

export function resolveAuth(flags?: {
  liAt?: string;
  jsessionid?: string;
}): LinkedInAuth {
  const config = loadLinkedInConfig();

  const liAt = flags?.liAt ?? process.env.LINKEDIN_LI_AT ?? config?.li_at;
  const jsessionid =
    flags?.jsessionid ?? process.env.LINKEDIN_JSESSIONID ?? config?.jsessionid;

  if (!liAt) {
    throw new Error(
      "No li_at cookie found. Set LINKEDIN_LI_AT, use --li-at, or run: linkedin login",
    );
  }
  if (!jsessionid) {
    throw new Error(
      "No JSESSIONID cookie found. Set LINKEDIN_JSESSIONID, use --jsessionid, or run: linkedin login",
    );
  }

  return { liAt, jsessionid };
}

export function createClient(auth: LinkedInAuth): LinkedInClient {
  const csrfToken = auth.jsessionid.replace(/"/g, "");

  const baseHeaders: Record<string, string> = {
    "csrf-token": csrfToken,
    cookie: `JSESSIONID="${csrfToken}"; li_at=${auth.liAt}`,
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "accept-language": "en-US,en;q=0.9",
    "x-li-lang": "en_US",
    "x-restli-protocol-version": "2.0.0",
    "x-li-track": JSON.stringify({
      clientVersion: "1.13.21",
      osName: "web",
      timezoneOffset: new Date().getTimezoneOffset() / -60,
      deviceFormFactor: "DESKTOP",
      mpName: "voyager-web",
    }),
  };

  let lastRequestTime = 0;

  async function request<T = unknown>(options: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    baseRequest?: boolean;
  }): Promise<T> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_GAP_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, MIN_REQUEST_GAP_MS - elapsed),
      );
    }

    const base = options.baseRequest ? LINKEDIN_BASE : VOYAGER_BASE;
    let url = `${base}${options.path}`;

    if (options.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = { ...baseHeaders };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json; charset=UTF-8";
      headers["origin"] = LINKEDIN_BASE;
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await randomDelay();

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch(url, {
          method: options.method,
          headers,
          body:
            options.body !== undefined
              ? JSON.stringify(options.body)
              : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeout);
        lastRequestTime = Date.now();

        if (!response.ok) {
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("text/html")) {
            throw new Error(
              "LinkedIn requires a CAPTCHA or verification. Refresh your cookie session.",
            );
          }
        }

        if (response.ok) {
          const text = await response.text();
          if (!text) return {} as T;
          try {
            return JSON.parse(text) as T;
          } catch {
            return text as unknown as T;
          }
        }

        if (response.status === 401) {
          throw new Error(
            "Session expired or invalid. Run: bun src/cli.ts linkedin login",
          );
        }

        if (response.status === 429 && attempt < MAX_RETRIES) {
          lastError = new Error(`Rate limited (429)`);
          continue;
        }

        if (response.status >= 500 && attempt < MAX_RETRIES) {
          lastError = new Error(`Server error (${response.status})`);
          continue;
        }

        const errorText = await response.text().catch(() => "");
        throw new Error(
          `LinkedIn API error ${response.status}: ${errorText.slice(0, 200)}`,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes("Session expired") ||
            error.message.includes("CAPTCHA"))
        ) {
          throw error;
        }
        lastError = error as Error;
        if (attempt >= MAX_RETRIES) throw lastError;
      }
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  return {
    request,
    get: <T = unknown>(path: string, query?: Record<string, unknown>) =>
      request<T>({
        method: "GET",
        path,
        query: query as Record<string, string>,
      }),
    post: <T = unknown>(
      path: string,
      body?: unknown,
      query?: Record<string, unknown>,
    ) =>
      request<T>({
        method: "POST",
        path,
        query: query as Record<string, string>,
        body,
      }),
    patch: <T = unknown>(path: string, body?: unknown) =>
      request<T>({ method: "PATCH", path, body }),
    put: <T = unknown>(path: string, body?: unknown) =>
      request<T>({ method: "PUT", path, body }),
    delete: <T = unknown>(path: string, query?: Record<string, unknown>) =>
      request<T>({
        method: "DELETE",
        path,
        query: query as Record<string, string>,
      }),
  };
}
