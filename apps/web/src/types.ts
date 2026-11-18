export type Notice = { kind: "ok" | "error"; text: string } | null;
export type Me = { userId: string; organizationId: string; roles: string[] };

/**
 * Demo configuration returned by `POST /dev/seed`. It is the single source of truth for the
 * shape of that response: the runtime may omit any optional field, so consumers must treat
 * every field except `organizationId` and `termsVersion` as possibly absent.
 */
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
