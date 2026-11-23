export type DemoConfig = {
  organizationId: string;
  buildingId?: string;
  pickupWindowId?: string;
  deliveryWindowId?: string;
  tariffVersionId?: string;
  serviceId?: string;
  termsVersion: string;
  shiftId?: string;
  demoUsers: Array<{ role: string; phone: string }>;
};

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly details?: unknown) {
    super(code);
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.key) headers["Idempotency-Key"] = options.key;
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? "GET",
    headers,
    credentials: "include",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(payload?.error?.code ?? "REQUEST_FAILED", response.status, payload?.error?.details);
  }
  return payload as T;
}

export const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const money = (kopeks: number) =>
  new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(kopeks / 100);
