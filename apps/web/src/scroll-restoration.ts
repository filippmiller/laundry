/**
 * Whether the remembered reading position may still be restored.
 *
 * WHY this decision exists on its own: the position of a workspace survives a reload, but the
 * workspace content arrives after the first paint — at that moment the document is still too
 * short to hold the remembered offset. The browser would restore the position on its own, at a
 * moment of its choosing and without telling anyone; the app restores it deliberately instead.
 *
 * But a restoration that fires after the reader has already scrolled somewhere else overrides
 * their choice: the page jumps back to a place they have left. Two rules follow from that:
 *
 * - the restoration waits until the document can really hold the offset;
 * - the reader's own scroll wins over the remembered position.
 */

/** How far the current offset may differ from the expected one and still count as "not moved". */
export const SCROLL_RESTORE_TOLERANCE_PX = 2;

/** How often the app checks whether the document has become tall enough. */
export const SCROLL_RESTORE_ATTEMPTS = 25;

/** What the caller has to do with the remembered position. */
export type ScrollRestoreDecision = "wait" | "restore" | "skip";

/**
 * Decides what to do with the remembered offset.
 *
 * @param target the remembered offset of the workspace, if there is one
 * @param currentScrollY where the page is right now
 * @param documentHeight how tall the document is right now
 * @param attemptsLeft how many checks are still allowed
 */
export function decideScrollRestore(options: {
  target: number | null | undefined;
  currentScrollY: number;
  documentHeight: number;
  attemptsLeft: number;
}): ScrollRestoreDecision {
  const { target, currentScrollY, documentHeight, attemptsLeft } = options;
  // Nothing to remember: the workspace was never read.
  if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) return "skip";
  // The document is still too short to hold the remembered offset.
  if (documentHeight < target + SCROLL_RESTORE_TOLERANCE_PX) {
    return attemptsLeft > 0 ? "wait" : "skip";
  }
  // The reader has scrolled somewhere else in the meantime: their choice wins over the memory.
  if (Math.abs(currentScrollY) > SCROLL_RESTORE_TOLERANCE_PX) return "skip";
  return "restore";
}
