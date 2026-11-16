export const transitions = {
  draft: ["confirmed", "cancelled"],
  confirmed: ["scheduled", "cancelled"],
  scheduled: ["pickup_assigned", "cancelled"],
  pickup_assigned: ["picked_up", "scheduled"],
  picked_up: ["at_hub", "partner_received"],
  at_hub: ["partner_received"],
  partner_received: ["inspection"],
  inspection: ["awaiting_approval", "processing"],
  awaiting_approval: ["processing", "inspection"],
  processing: ["quality_check"],
  quality_check: ["processing", "ready"],
  ready: ["out_for_delivery"],
  out_for_delivery: ["delivered", "ready"],
  delivered: ["closed"],
  closed: [],
  cancelled: [],
} as const;

export type OrderState = keyof typeof transitions;

export function canTransition(from: OrderState, to: OrderState): boolean {
  return (transitions[from] as readonly string[]).includes(to);
}

export function transition(from: OrderState, to: OrderState): OrderState {
  if (!canTransition(from, to)) throw new Error(`INVALID_TRANSITION: ${from} -> ${to}`);
  return to;
}
