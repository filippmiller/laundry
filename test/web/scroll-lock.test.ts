import { describe, expect, it } from "vitest";
import {
  SCROLL_LOCK_KEYS,
  decideScrollGuard,
  shouldLockScroll,
} from "../../apps/web/src/scroll-lock.js";

/**
 * The page behind the open mobile drawer is frozen — without touching the layout.
 *
 * The obvious way to freeze a page is `overflow: hidden` on <html>/<body>. It
 * does freeze the page, but it also collapses the scrollable range of the
 * document: the browser clamps the offset to the new maximum, so the content
 * the user was reading lands on another line (M-3). It also turns the body into
 * a scroll container, and the sticky topbar and tab strip stop sticking — they
 * go away together with the content.
 *
 * So the freeze is done with the input instead of with the layout: the wheel,
 * the touch and the scroll keys are not allowed to scroll the page, and a scroll
 * that still happens for another reason is put back where it was.
 */
describe("the freeze of the page behind the open drawer", () => {
  it("blocks the wheel outside the drawer", () => {
    expect(shouldLockScroll({ kind: "wheel", insideDrawer: false })).toBe(true);
  });

  it("blocks the touch outside the drawer", () => {
    expect(shouldLockScroll({ kind: "touchmove", insideDrawer: false })).toBe(true);
  });

  it("lets the drawer scroll itself", () => {
    // The rail is its own scroll container (`overflow-y: auto`): a wheel over it
    // has to scroll the menu, not the page behind the menu.
    expect(shouldLockScroll({ kind: "wheel", insideDrawer: true })).toBe(false);
    expect(shouldLockScroll({ kind: "touchmove", insideDrawer: true })).toBe(false);
  });

  it("blocks the keys that scroll the page", () => {
    for (const key of ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]) {
      expect(shouldLockScroll({ kind: "keydown", key, insideDrawer: false })).toBe(true);
    }
  });

  it("names every key it blocks", () => {
    expect([...SCROLL_LOCK_KEYS].sort()).toEqual(
      [" ", "ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp"].sort(),
    );
  });

  it("lets the other keys through", () => {
    // Escape closes the drawer, and a letter typed into the drawer has to reach
    // the drawer — the freeze is about the page, not about the keyboard.
    expect(shouldLockScroll({ kind: "keydown", key: "Escape", insideDrawer: false })).toBe(false);
    expect(shouldLockScroll({ kind: "keydown", key: "a", insideDrawer: false })).toBe(false);
  });

  it("lets the keys through inside the drawer", () => {
    // The focus is inside the drawer while it is open: Space has to activate
    // the focused button, and the arrows have to move the menu.
    expect(shouldLockScroll({ kind: "keydown", key: "PageDown", insideDrawer: true })).toBe(false);
    expect(shouldLockScroll({ kind: "keydown", key: " ", insideDrawer: true })).toBe(false);
  });
});

/**
 * A scroll that happened anyway — a dragged scrollbar, a focused element, a
 * programmatic jump — has to be put back where it was, and it has to be put
 * back only as far as the document can still reach.
 *
 * But the offset is not the only witness: the browser moves the offset itself
 * when a panel arrives above the reading position, and then the content the
 * user reads stays exactly where it was. Moving the offset back in that case
 * would move the content — the guard would cause the very jump it is there to
 * prevent.
 */
describe("the guard that puts the offset back", () => {
  it("does nothing while the offset is where it belongs", () => {
    expect(
      decideScrollGuard({ current: 600, locked: 600, maxOffset: 4000, witnessMoved: true }),
    ).toEqual({ kind: "hold" });
  });

  it("puts the offset back where it was", () => {
    expect(
      decideScrollGuard({ current: 192, locked: 600, maxOffset: 4000, witnessMoved: true }),
    ).toEqual({ kind: "restore", top: 600 });
  });

  it("puts the offset back only as far as the document reaches", () => {
    // The document became shorter while the drawer was open: the offset of the
    // reader is out of reach, and the guard must not fight the browser over it.
    expect(
      decideScrollGuard({ current: 100, locked: 600, maxOffset: 192, witnessMoved: true }),
    ).toEqual({ kind: "restore", top: 192 });
  });

  it("never asks for a negative offset", () => {
    expect(
      decideScrollGuard({ current: 120, locked: 600, maxOffset: -50, witnessMoved: true }),
    ).toEqual({ kind: "restore", top: 0 });
  });

  it("adopts the offset after confirmed browser compensation instead of fighting it", () => {
    // The offset moved, but the content the user reads did not: the browser
    // compensated the offset itself. Adopting the compensated offset preserves
    // the reading line on any subsequent scroll (LND-W9-RET-03).
    expect(
      decideScrollGuard({ current: 900, locked: 600, maxOffset: 4000, witness: "held" }),
    ).toEqual({ kind: "adopt", top: 900 });
  });

  it("holds without updating locked offset when the witness is missing", () => {
    expect(
      decideScrollGuard({ current: 900, locked: 600, maxOffset: 4000, witness: "missing" }),
    ).toEqual({ kind: "hold" });
  });
});
