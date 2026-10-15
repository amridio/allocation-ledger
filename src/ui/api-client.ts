import type { EntriesPageDto, EntryDto, MetricDto, TimelineDto } from "@/domain/wire";

/** An API error in a shape the UI can act on. */
export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Safe to try again with the SAME Idempotency-Key (timeouts, busy pool, network, gateway errors). */
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export interface WriteResult {
  replay: boolean;
  entry: EntryDto;
}

export interface EntriesRequest {
  limit: number;
  cursor?: number | undefined;
  operatorId?: string | undefined;
}

const isRetryable = (status: number) => status === 503 || status === 502 || status === 504 || status === 0;

/** Typed wrappers over the API. `fetchImpl` is injectable so the behaviour is unit-testable. */
export function createApiClient(fetchImpl: typeof fetch = (...args) => fetch(...args)) {
  async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(url, { credentials: "same-origin", cache: "no-store", ...init });
    } catch {
      throw new ApiClientError(0, "NETWORK", "Can't reach the server. Check your connection.", true);
    }
    if (response.ok) return (await response.json()) as T;

    let code = `HTTP_${response.status}`;
    let message = `The server answered ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      // not JSON (e.g. a gateway's HTML error page): keep the generic code and message
    }
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ApiClientError(
      response.status,
      code,
      message,
      isRetryable(response.status),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  const post = <T>(url: string, body: unknown, idempotencyKey?: string) =>
    request<T>(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      body: JSON.stringify(body),
    });

  return {
    getMetric: (operatorId?: string) =>
      request<MetricDto>(operatorId === undefined ? "/api/metric" : `/api/metric?operatorId=${encodeURIComponent(operatorId)}`),

    getEntries: ({ limit, cursor, operatorId }: EntriesRequest) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor !== undefined) query.set("cursor", String(cursor));
      if (operatorId !== undefined) query.set("operatorId", operatorId);
      return request<EntriesPageDto>(`/api/entries?${query}`);
    },

    getTimeline: (operatorId: string, view?: "transitions" | "full") =>
      request<TimelineDto>(`/api/operators/${encodeURIComponent(operatorId)}/timeline${view ? `?view=${view}` : ""}`),

    postEntry: (units: number, idempotencyKey: string) => post<WriteResult>("/api/entries", { units }, idempotencyKey),

    postAdjustment: (body: { targetSeq: number; units: number; reason: string }, idempotencyKey: string) =>
      post<WriteResult>("/api/adjustments", body, idempotencyKey),

    switchUser: (userId: string) => post<{ user: { id: string } }>("/api/switch-user", { userId }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
