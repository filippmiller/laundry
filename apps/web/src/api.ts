export type DemoConfig = {
  organizationId: string;
  buildingId?: string;
  pickupWindowId?: string;
  deliveryWindowId?: string;
  tariffVersionId?: string;
  serviceId?: string;
  termsVersion: string;
  shiftId?: string;
  buildings?: Array<{ id: string; address: string; pickupWindowId: string | null; deliveryWindowId: string | null }>;
  services?: Array<{ id: string; code: string; name: string; unit: string }>;
  partners?: Array<{ id: string; name: string }>;
  demoUsers: Array<{ role: string; phone: string; displayName?: string }>;
};

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly details?: unknown) {
    super(code);
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  // Auto-attach idempotency key on mutating calls unless explicitly suppressed.
  if (options.key) {
    headers["Idempotency-Key"] = options.key;
  } else if (method === "POST" || method === "PUT" || method === "PATCH") {
    headers["Idempotency-Key"] = newKey();
  }
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: "include",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(payload?.error?.code ?? payload?.error?.message ?? "REQUEST_FAILED", response.status, payload?.error?.details);
  }
  return payload as T;
}

export const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const money = (kopeks: number) =>
  new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format((kopeks ?? 0) / 100);

export const dt = (iso: string | Date | null | undefined) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
};

export async function sha256FileHex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}
