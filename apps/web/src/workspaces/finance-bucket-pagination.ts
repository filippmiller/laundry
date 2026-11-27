/**
 * Request ownership for the paginated payout and credit-note buckets of the finance workspace.
 *
 * Each of the four bucket queues (payouts active/history, credit notes active/history) loads
 * additional pages asynchronously. A full finance refresh replaces all four buckets with page 1,
 * so any in-flight append from an older overview epoch — whether it resolves, rejects or finishes
 * in `finally` — must be ignored so it cannot append stale rows, overwrite fresh `totalCount` /
 * `nextCursor` / `hasMore`, report stale errors or clear the busy state of a newer action.
 */

export type FinanceBucketKey =
  | "payouts:active"
  | "payouts:history"
  | "creditNotes:active"
  | "creditNotes:history";

export type BucketAppendToken = {
  readonly bucket: FinanceBucketKey;
  readonly overviewEpoch: number;
  readonly bucketSeq: number;
};

export type BucketBusyMap = Record<FinanceBucketKey, boolean>;

export const EMPTY_BUCKET_BUSY: BucketBusyMap = {
  "payouts:active": false,
  "payouts:history": false,
  "creditNotes:active": false,
  "creditNotes:history": false,
};

export type BucketPaginationGuard = {
  /** Invalidates every in-flight append across all four buckets (called on full finance refresh). */
  invalidateAll(): number;
  /** Claims ownership of an append for `bucket`, invalidating any earlier append for that bucket. */
  beginAppend(bucket: FinanceBucketKey): BucketAppendToken;
  /** True iff no full refresh and no newer append on `token.bucket` has superseded `token`. */
  isCurrent(token: BucketAppendToken): boolean;
};

export function createBucketPaginationGuard(): BucketPaginationGuard {
  let overviewEpoch = 0;
  const bucketSeq: Record<FinanceBucketKey, number> = {
    "payouts:active": 0,
    "payouts:history": 0,
    "creditNotes:active": 0,
    "creditNotes:history": 0,
  };

  return {
    invalidateAll() {
      overviewEpoch += 1;
      return overviewEpoch;
    },
    beginAppend(bucket) {
      bucketSeq[bucket] += 1;
      return {
        bucket,
        overviewEpoch,
        bucketSeq: bucketSeq[bucket],
      };
    },
    isCurrent(token) {
      return (
        token.overviewEpoch === overviewEpoch &&
        token.bucketSeq === bucketSeq[token.bucket]
      );
    },
  };
}
