/**
 * GLM / Z.ai usage & quota client.
 *
 * Queries the monitoring endpoints exposed by Z.ai (`api.z.ai`) and
 * ZHIPU BigModel (`open.bigmodel.cn` / `dev.bigmodel.cn`) using the
 * same `ANTHROPIC_AUTH_TOKEN` the agent uses for inference. Pure HTTP
 * calls — no LLM involved — so the `/acp-glm` bridge command can answer
 * directly without spinning up an agent turn.
 */

/** Which usage backend a base URL points at. */
export type UsagePlatform = "ZAI" | "ZHIPU";

export interface UsageClientParams {
  baseUrl: string;
  token: string;
  /** Request timeout in milliseconds. Defaults to 15s. */
  timeoutMs?: number;
}

/**
 * Quota window units observed on ZHIPU / Z.ai `quota/limit` responses.
 * `TOKENS_LIMIT` rows carry a `unit` telling which rolling window the
 * percentage refers to. Unknown values are rendered verbatim.
 */
const UNIT_LABELS: Readonly<Record<number, string>> = {
  1: "daily",
  3: "5h",
  5: "minute",
  6: "weekly",
};

/** A single quota row returned by `quota/limit`. */
export interface QuotaLimitItem {
  type: string;
  /** Authoritative percentage, already in percent (e.g. `13` → 13%). */
  percentage: number;
  /** Window unit for `TOKENS_LIMIT` rows (see {@link UNIT_LABELS}). */
  unit?: number;
  number?: number;
  /** Present on `TIME_LIMIT` rows (e.g. MCP monthly usage). */
  currentValue?: number;
  usage?: number;
  remaining?: number;
  /** Epoch milliseconds when the window resets. */
  nextResetTime?: number;
  usageDetails?: Array<{ modelCode?: string; usage?: number }>;
}

export interface QuotaLimitResponse {
  limits: QuotaLimitItem[];
  /** Plan tier, e.g. `lite`, `pro`, `max`. */
  level?: string;
}

export interface UsageSnapshot {
  platform: UsagePlatform;
  quota: QuotaLimitResponse | null;
  errors: string[];
}

export class UsageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageConfigError";
  }
}

export class UsageRequestError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "UsageRequestError";
    this.statusCode = statusCode;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Resolve which usage backend to query from the agent's
 * `ANTHROPIC_BASE_URL`. Throws {@link UsageConfigError} on unknown hosts.
 */
export function resolveUsagePlatform(baseUrl: string): UsagePlatform {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new UsageConfigError(
      `ANTHROPIC_BASE_URL is not a valid URL: ${JSON.stringify(baseUrl)}`,
    );
  }
  if (host === "api.z.ai" || host.endsWith(".z.ai")) {
    return "ZAI";
  }
  if (
    host === "open.bigmodel.cn" ||
    host === "dev.bigmodel.cn" ||
    host.endsWith(".bigmodel.cn")
  ) {
    return "ZHIPU";
  }
  throw new UsageConfigError(
    `Unsupported ANTHROPIC_BASE_URL: ${JSON.stringify(baseUrl)}. ` +
      "Expected api.z.ai or open.bigmodel.cn.",
  );
}

function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: token,
    "Accept-Language": "en-US,en",
    "Content-Type": "application/json",
  };
}

async function getJson<T>(
  url: string,
  params: UsageClientParams,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: buildHeaders(params.token),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error ? err.message : String(err);
    throw new UsageRequestError(
      `Network error while calling ${url}: ${reason}`,
    );
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  if (res.status !== 200) {
    throw new UsageRequestError(
      `HTTP ${res.status} from ${url}: ${body.slice(0, 300)}`,
      res.status,
    );
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new UsageRequestError(`Non-JSON response from ${url}: ${body.slice(0, 300)}`);
  }
}

/**
 * Fetch the account's quota limits. The endpoint ignores start/end query
 * params and always returns the current rolling window, so unlike
 * `model-usage` / `tool-usage` it takes no time range.
 */
export async function fetchQuotaLimit(
  params: UsageClientParams,
): Promise<QuotaLimitResponse> {
  const platform = resolveUsagePlatform(params.baseUrl);
  const { protocol, host } = new URL(params.baseUrl);
  const url =
    `${protocol}//${host}/api/monitor/usage/quota/limit`;
  const json = await getJson<{ data?: QuotaLimitResponse } | QuotaLimitResponse>(
    url,
    params,
  );
  const data = (json as { data?: QuotaLimitResponse }).data;
  if (!data || !Array.isArray(data.limits)) {
    throw new UsageRequestError(`Unexpected quota response shape from ${url}`);
  }
  return data;
}

export function describeQuotaWindow(item: QuotaLimitItem): string {
  switch (item.type) {
    case "TOKENS_LIMIT": {
      const label = item.unit !== undefined ? UNIT_LABELS[item.unit] : undefined;
      return label ? `Tokens · ${label} window` : "Tokens";
    }
    case "TIME_LIMIT":
      return "MCP · monthly";
    default:
      return item.type;
  }
}

/**
 * Convenience wrapper returning a {@link UsageSnapshot}. Request errors
 * are captured into `errors` rather than thrown so callers can render a
 * partial report (e.g. token works but the endpoint is down).
 */
export async function fetchUsageSnapshot(
  params: UsageClientParams,
): Promise<UsageSnapshot> {
  const platform = resolveUsagePlatform(params.baseUrl);
  const errors: string[] = [];
  let quota: QuotaLimitResponse | null = null;
  try {
    quota = await fetchQuotaLimit(params);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return { platform, quota, errors };
}
