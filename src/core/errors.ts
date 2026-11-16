export type ErrorCode =
  | "VALIDATION_ERROR" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND"
  | "CONFLICT_VERSION" | "INVALID_TRANSITION" | "CAPACITY_UNAVAILABLE"
  | "QUOTE_EXPIRED" | "APPROVAL_REQUIRED" | "PAYMENT_PENDING"
  | "DEPENDENCY_UNAVAILABLE" | "IDEMPOTENCY_PAYLOAD_CONFLICT"
  | "IDEMPOTENCY_IN_PROGRESS" | "IDEMPOTENCY_OWNER_MISMATCH" | "WINDOW_NOT_FOUND" | "INVALID_EXPIRY"
  | "DISCREPANCY_REQUIRED" | "UNBALANCED_JOURNAL" | "FINANCIAL_HOLD"
  | "EVIDENCE_REQUIRED" | "CUSTODY_CONFLICT";

const statusByCode: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT_VERSION: 409,
  INVALID_TRANSITION: 409,
  CAPACITY_UNAVAILABLE: 409,
  QUOTE_EXPIRED: 409,
  APPROVAL_REQUIRED: 409,
  PAYMENT_PENDING: 409,
  DEPENDENCY_UNAVAILABLE: 503,
  IDEMPOTENCY_PAYLOAD_CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  IDEMPOTENCY_OWNER_MISMATCH: 409,
  WINDOW_NOT_FOUND: 404,
  INVALID_EXPIRY: 400,
  DISCREPANCY_REQUIRED: 409,
  UNBALANCED_JOURNAL: 409,
  FINANCIAL_HOLD: 409,
  EVIDENCE_REQUIRED: 409,
  CUSTODY_CONFLICT: 409,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(code: ErrorCode, message: string = code, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = statusByCode[code];
    this.details = details;
  }
}

export const errors = {
  notFound: (resource = "resource") => new AppError("NOT_FOUND", "NOT_FOUND", { resource }),
  forbidden: (reason = "insufficient scope") => new AppError("FORBIDDEN", "FORBIDDEN", { reason }),
  unauthorized: () => new AppError("UNAUTHORIZED", "UNAUTHORIZED"),
  version: (current: number) => new AppError("CONFLICT_VERSION", "CONFLICT_VERSION", { currentVersion: current }),
  transition: (from: string, to: string) => new AppError("INVALID_TRANSITION", "INVALID_TRANSITION", { from, to }),
};
