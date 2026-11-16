import { pgEnum } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", [
  "customer", "courier", "driver", "hub_worker", "laundry_operator",
  "laundry_supervisor", "partner_finance", "dispatcher", "customer_support",
  "claims_investigator", "claims_approver", "platform_finance",
  "platform_admin", "security_auditor", "system_worker",
]);

export const membershipState = pgEnum("membership_state", ["active", "suspended", "revoked"]);
export const windowKind = pgEnum("window_kind", ["pickup", "delivery"]);
export const windowStatus = pgEnum("window_status", ["draft", "open", "closed", "cancelled"]);
export const reservationState = pgEnum("reservation_state", ["held", "confirmed", "released", "expired", "failed"]);
export const quoteState = pgEnum("quote_state", ["draft", "active", "accepted", "expired", "cancelled"]);
export const orderState = pgEnum("order_state", [
  "draft", "confirmed", "scheduled", "pickup_assigned", "picked_up", "at_hub",
  "partner_received", "inspection", "awaiting_approval", "processing",
  "quality_check", "ready", "out_for_delivery", "delivered", "closed", "cancelled",
]);
export const tierEnum = pgEnum("tier", ["economy", "protected"]);
export const adjustmentState = pgEnum("adjustment_state", ["proposed", "accepted", "declined", "expired"]);
export const manifestMode = pgEnum("manifest_mode", ["economy_bag", "protected_items", "mixed"]);
export const sealState = pgEnum("seal_state", ["available", "assigned", "broken", "void"]);
export const scanSyncState = pgEnum("scan_sync_state", ["pending", "accepted", "duplicate", "rejected", "conflict"]);
export const disputeState = pgEnum("dispute_state", ["open", "investigating", "resolved", "rejected"]);
export const evidenceState = pgEnum("evidence_state", ["pending_upload", "verified", "quarantined", "retained", "legal_hold", "expired"]);
export const receiptState = pgEnum("receipt_state", ["expected", "pending", "accepted", "discrepancy", "rejected"]);
export const batchState = pgEnum("batch_state", ["created", "processing", "quality_check", "packed", "cancelled"]);
export const shiftState = pgEnum("shift_state", ["planned", "active", "completed", "abandoned"]);
export const routeStopState = pgEnum("route_stop_state", ["pending", "en_route", "arrived", "completed", "failed", "rescheduled"]);
export const attemptOutcome = pgEnum("attempt_outcome", ["delivered", "recipient_unavailable", "wrong_recipient", "refused", "partial", "damaged"]);
export const paymentState = pgEnum("payment_state", ["pending", "authorized", "captured", "partially_refunded", "refunded", "failed", "disputed", "chargeback_lost"]);
export const fiscalState = pgEnum("fiscal_state", ["not_created", "pending_registration", "registered", "retry_pending", "correction_requested", "correction_pending", "corrected", "failed"]);
export const ledgerState = pgEnum("ledger_state", ["draft", "posted", "reversed"]);
export const claimState = pgEnum("claim_state", ["opened", "triage", "investigating", "decision_pending", "resolved", "denied_with_reason", "escalated", "reopened"]);
export const outboxState = pgEnum("outbox_state", ["pending", "processing", "processed", "failed"]);
