import { describe, expect, it } from "vitest";
import {
  SCROLL_RESTORE_ATTEMPTS,
  SCROLL_RESTORE_TOLERANCE_PX,
  decideScrollRestore,
} from "../../apps/web/src/scroll-restoration.js";

/**
 * The reading position of a workspace survives a reload — but not at the cost of the reader's
 * own choice.
 *
 * The browser restores the position of the previous page on its own, at a moment of its choosing
 * and without a scroll event. The app restores it deliberately instead, because the workspace
 * content arrives after the first paint. Two things must hold: the restoration waits until the
 * offset is really reachable, and a reader who has already scrolled somewhere else is not
 * dragged back.
 */
describe("the restoration of the remembered reading position", () => {
  it("waits while the document is still too short to hold the offset", () => {
    expect(
      decideScrollRestore({
        target: 800,
        currentScrollY: 0,
        documentHeight: 500,
        viewportHeight: 800,
        attemptsLeft: 20,
      }),
    ).toBe("wait");
  });

  it("gives up when the document never becomes tall enough", () => {
    expect(
      decideScrollRestore({
        target: 800,
        currentScrollY: 0,
        documentHeight: 500,
        viewportHeight: 800,
        attemptsLeft: 0,
      }),
    ).toBe("skip");
  });

  it("restores the offset once the document can hold it", () => {
    expect(
      decideScrollRestore({
        target: 800,
        currentScrollY: 0,
        documentHeight: 5000,
        viewportHeight: 800,
        attemptsLeft: 20,
      }),
    ).toBe("restore");
  });

  it("waits while the offset is out of reach, even if the document is taller than it", () => {
    // The height of the document is not the measure: the browser scrolls to `height - viewport`.
    // A document of 1000 px with a viewport of 800 px can only be scrolled to 200 px, so an
    // offset of 800 would be clamped and the reader would land on a different line.
    expect(
      decideScrollRestore({
        target: 800,
        currentScrollY: 0,
        documentHeight: 1000,
        viewportHeight: 800,
        attemptsLeft: 20,
      }),
    ).toBe("wait");
  });

  it("restores the offset when the reachable range covers it", () => {
    expect(
      decideScrollRestore({
        target: 200,
        currentScrollY: 0,
        documentHeight: 1000,
        viewportHeight: 800,
        attemptsLeft: 20,
      }),
    ).toBe("restore");
  });

  it("leaves the reader alone once they have scrolled somewhere else", () => {
    expect(
      decideScrollRestore({
        target: 800,
        currentScrollY: 600,
        documentHeight: 5000,
        viewportHeight: 800,
        attemptsLeft: 20,
      }),
    ).toBe("skip");
  });

  it("treats a difference within the tolerance as not having moved", () => {
    expect(
      decideScrollRestore({
        target: 800,
        currentScrollY: SCROLL_RESTORE_TOLERANCE_PX,
        documentHeight: 5000,
        viewportHeight: 800,
        attemptsLeft: 20,
      }),
    ).toBe("restore");
    expect(
      decideScrollRestore({
        target: 800,
        currentScrollY: SCROLL_RESTORE_TOLERANCE_PX + 1,
        documentHeight: 5000,
        viewportHeight: 800,
        attemptsLeft: 20,
      }),
    ).toBe("skip");
  });

  it("has nothing to restore without a remembered offset", () => {
    expect(
      decideScrollRestore({
        target: undefined,
        currentScrollY: 0,
        documentHeight: 5000,
        viewportHeight: 800,
        attemptsLeft: 20,
      }),
    ).toBe("skip");
    expect(
      decideScrollRestore({
        target: null,
        currentScrollY: 0,
        documentHeight: 5000,
        viewportHeight: 800,
        attemptsLeft: 20,
      }),
    ).toBe("skip");
    expect(
      decideScrollRestore({
        target: 0,
        currentScrollY: 0,
        documentHeight: 5000,
        viewportHeight: 800,
        attemptsLeft: 20,
      }),
    ).toBe("skip");
    expect(
      decideScrollRestore({
        target: -5,
        currentScrollY: 0,
        documentHeight: 5000,
        viewportHeight: 800,
        attemptsLeft: 20,
      }),
    ).toBe("skip");
  });

  it("checks often enough for a workspace that loads slowly", () => {
    // 25 checks every 120 ms: the restoration has a chance before the reader gives up waiting.
    expect(SCROLL_RESTORE_ATTEMPTS * 120).toBeGreaterThanOrEqual(2500);
  });
});
