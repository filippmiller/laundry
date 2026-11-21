import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, users } from "./01-identity.js";

/**
 * A scanning device is bound to one courier. The id is generated on the device and registered
 * once; a scan carrying a device id that is not bound to the acting courier is rejected.
 */
export const courierDevices = pgTable("courier_devices", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  courierId: uuid("courier_id").notNull().references(() => users.id),
  label: text("label").notNull().default("courier device"),
  state: text("state").notNull().default("active"),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
}, t => [
  uniqueIndex("courier_devices_org_courier_unique").on(t.organizationId, t.courierId, t.id),
  index("courier_devices_org_state_idx").on(t.organizationId, t.state),
]);
