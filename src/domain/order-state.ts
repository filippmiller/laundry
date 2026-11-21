import { hasRole, type Principal, type Role } from "../core/context.js";
import { errors } from "../core/errors.js";

export type OrderState =
  | "draft" | "confirmed" | "scheduled" | "pickup_assigned" | "picked_up" | "at_hub"
  | "partner_received" | "inspection" | "awaiting_approval" | "processing"
  | "quality_check" | "ready" | "out_for_delivery" | "delivered" | "closed" | "cancelled";

type Transition = { to: OrderState; roles: Role[] };
export const ORDER_TRANSITIONS: Record<OrderState, Record<string, Transition>> = {
  draft: {
    confirm: { to: "confirmed", roles: ["customer", "dispatcher", "platform_admin"] },
    cancel: { to: "cancelled", roles: ["customer", "dispatcher", "platform_admin"] },
  },
  confirmed: {
    reserve_pickup: { to: "scheduled", roles: ["customer", "dispatcher", "system_worker"] },
    cancel: { to: "cancelled", roles: ["customer", "dispatcher", "platform_admin"] },
  },
  scheduled: {
    assign_pickup: { to: "pickup_assigned", roles: ["dispatcher", "platform_admin"] },
    cancel: { to: "cancelled", roles: ["customer", "dispatcher", "platform_admin"] },
  },
  pickup_assigned: {
    accept_handoff: { to: "picked_up", roles: ["courier", "dispatcher"] },
    fail_pickup: { to: "scheduled", roles: ["courier", "dispatcher"] },
    cancel: { to: "cancelled", roles: ["dispatcher", "platform_admin"] },
  },
  picked_up: {
    hub_receive: { to: "at_hub", roles: ["hub_worker", "dispatcher"] },
    partner_receive: { to: "partner_received", roles: ["laundry_operator", "laundry_supervisor", "hub_worker"] },
  },
  at_hub: {
    partner_receive: { to: "partner_received", roles: ["laundry_operator", "laundry_supervisor", "hub_worker"] },
    ready_for_return: { to: "ready", roles: ["laundry_operator", "laundry_supervisor", "hub_worker", "dispatcher"] },
  },
  partner_received: { inspect: { to: "inspection", roles: ["laundry_operator", "laundry_supervisor"] } },
  inspection: {
    propose_change: { to: "awaiting_approval", roles: ["laundry_operator", "laundry_supervisor"] },
    start_processing: { to: "processing", roles: ["laundry_operator", "laundry_supervisor"] },
    return_unprocessed: { to: "at_hub", roles: ["laundry_operator", "laundry_supervisor", "dispatcher"] },
  },
  awaiting_approval: {
    approve_change: { to: "processing", roles: ["customer", "platform_admin"] },
    decline_change: { to: "inspection", roles: ["customer", "platform_admin"] },
  },
  processing: { qc_start: { to: "quality_check", roles: ["laundry_operator", "laundry_supervisor"] } },
  quality_check: {
    pack: { to: "ready", roles: ["laundry_operator", "laundry_supervisor"] },
    rewash: { to: "processing", roles: ["laundry_supervisor", "dispatcher"] },
  },
  ready: { dispatch: { to: "out_for_delivery", roles: ["dispatcher", "platform_admin"] } },
  out_for_delivery: {
    handover: { to: "delivered", roles: ["courier", "dispatcher"] },
    failed_attempt: { to: "ready", roles: ["courier", "dispatcher"] },
  },
  delivered: { close: { to: "closed", roles: ["system_worker", "platform_finance", "platform_admin"] } },
  closed: {},
  cancelled: {},
};

export function nextState(from: OrderState, command: string, principal: Principal): OrderState {
  const transition = ORDER_TRANSITIONS[from]?.[command];
  if (!transition) throw errors.transition(from, command);
  if (!principal || !Array.isArray(principal.roles) || principal.roles.length === 0) {
    throw errors.forbidden(`command ${command} requires an authenticated principal`);
  }
  if (!hasRole(principal, ...transition.roles)) {
    throw errors.forbidden(`command ${command} requires ${transition.roles.join(" or ")}`);
  }
  return transition.to;
}

/**
 * Explicit system-level transition for documented server-side escalations (e.g. automatic QC
 * rewash or customer-declined unprocessed return) after caller authorization has been verified.
 */
export function nextStateAsSystem(
  from: OrderState,
  command: string,
  context: { systemActor: string; reason: string },
): OrderState {
  const transition = ORDER_TRANSITIONS[from]?.[command];
  if (!transition) throw errors.transition(from, command);
  if (!context?.systemActor?.trim() || !context?.reason?.trim()) {
    throw errors.forbidden(`system transition ${command} requires systemActor and reason`);
  }
  return transition.to;
}

/** Independent domains are projected into one UI state; exceptions win. */
export function projectUiState(input: {
  lifecycle: OrderState;
  claimOpen?: boolean;
  deliveryPartial?: boolean;
  paymentDisputed?: boolean;
  custodyDisputed?: boolean;
}) {
  if (input.claimOpen) return "claim_open";
  if (input.custodyDisputed) return "exception";
  if (input.deliveryPartial) return "partially_delivered";
  if (input.paymentDisputed) return "payment_disputed";
  return input.lifecycle;
}
