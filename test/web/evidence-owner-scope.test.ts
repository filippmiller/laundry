import { describe, expect, it } from "vitest";
import {
  deriveEvidenceQueueRows,
  forgetSentPhotos,
  recordSentPhotos,
  sentPhotosFor,
  type EvidenceQueueRecord,
  type OwnerScopedPhotos,
} from "../../apps/web/src/components/evidence-queue-state.js";

/**
 * LND-R5-O01: the courier may open the next order while the upload of the previous one is still
 * running. The row that says "sent" belongs to the order the photo was attached to — under the
 * next order it would name a file the courier never sent there. The repository has no DOM harness,
 * so the behaviour is covered here as pure logic over the owner-scoped registry.
 */
function photo(id: string): EvidenceQueueRecord {
  return {
    id,
    fileName: `${id}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: 2048,
    createdAt: "2026-11-27T09:00:00.000Z",
    attempts: 1,
    lastError: null,
  };
}

const OWNER_A = "order:A";
const OWNER_B = "order:B";

describe("LND-R5-O01: the accepted photos belong to the order they were attached to", () => {
  it("shows the accepted photo under the owner that sent it", () => {
    const sent = recordSentPhotos<EvidenceQueueRecord>({}, OWNER_A, [photo("photo-a")]);

    expect(sentPhotosFor(sent, OWNER_A).map(item => item.id)).toEqual(["photo-a"]);
  });

  it("does not show the accepted photo of the previous order under the next one", () => {
    const sent = recordSentPhotos<EvidenceQueueRecord>({}, OWNER_A, [photo("photo-a")]);

    // The courier opened the next order while the upload of the previous one was running.
    expect(sentPhotosFor(sent, OWNER_B)).toEqual([]);
  });

  it("keeps a late completion of the previous order out of the rows of the current one", () => {
    let sent: OwnerScopedPhotos<EvidenceQueueRecord> = recordSentPhotos(
      {},
      OWNER_B,
      [photo("photo-b")],
    );
    // The answer of the previous order arrives after the courier moved on.
    sent = recordSentPhotos(sent, OWNER_A, [photo("photo-a")]);

    const rows = deriveEvidenceQueueRows(
      [...sentPhotosFor(sent, OWNER_B)],
      [],
      sentPhotosFor(sent, OWNER_B).map(item => item.id),
    );

    expect(rows.map(row => row.id)).toEqual(["photo-b"]);
    expect(rows.map(row => row.state)).toEqual(["sent"]);
  });

  it("does not let the timer of the previous order clear the row of the current one", () => {
    let sent: OwnerScopedPhotos<EvidenceQueueRecord> = recordSentPhotos(
      {},
      OWNER_B,
      [photo("photo-b")],
    );
    sent = recordSentPhotos(sent, OWNER_A, [photo("photo-a")]);
    // The five-second timer of order A fires and removes exactly its own photo.
    sent = forgetSentPhotos(sent, OWNER_A, ["photo-a"]);

    expect(sentPhotosFor(sent, OWNER_A)).toEqual([]);
    expect(sentPhotosFor(sent, OWNER_B).map(item => item.id)).toEqual(["photo-b"]);
  });

  it("shows a repeated completion of the same photo only once", () => {
    let sent = recordSentPhotos<EvidenceQueueRecord>({}, OWNER_A, [photo("photo-a")]);
    sent = recordSentPhotos(sent, OWNER_A, [photo("photo-a")]);

    expect(sentPhotosFor(sent, OWNER_A)).toHaveLength(1);
  });
});
