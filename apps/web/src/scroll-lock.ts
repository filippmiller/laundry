/**
 * The freeze of the page behind the open mobile drawer (MA-08).
 *
 * The page behind the menu must not scroll while the menu is open, and it has
 * to come back to the same line when the menu closes.
 *
 * The usual way to freeze a page is `overflow: hidden` on <html>/<body>. It
 * does freeze the page, but it costs two things that this app cannot pay:
 *
 *  - it collapses the scrollable range of the document, so the browser clamps
 *    the offset to the new maximum and the content the user was reading lands
 *    on another line (M-3);
 *  - it turns the body into a scroll container, and the sticky topbar and tab
 *    strip stop sticking — they go away together with the content.
 *
 * So the freeze is done with the input instead of with the layout: the wheel,
 * the touch and the scroll keys are not allowed to scroll the page, and a scroll
 * that happens for another reason is put back where it was.
 */

/** The keys that scroll the page while the page has the focus. */
export const SCROLL_LOCK_KEYS: readonly string[] = [
  " ",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
];

/** The events that can scroll the page while the drawer is open. */
export type ScrollLockInput =
  | { kind: "wheel" | "touchmove"; insideDrawer: boolean; insideDialog?: boolean }
  | {
      kind: "keydown";
      key: string;
      insideDrawer: boolean;
      insideDialog?: boolean;
      interactiveTarget?: boolean;
    };

/**
 * Should the event be prevented?
 *
 * Inside the drawer nothing is frozen: the rail is its own scroll container
 * (`overflow-y: auto`) and the keyboard belongs to the menu — Space has to
 * activate the focused button, and the arrows have to move the menu.
 *
 * Inside an open top-layer `<dialog>` (e.g. «Мои данные и сессии») the dialog
 * owns wheel, touch and keyboard input. Interactive controls outside the rail
 * (such as the «Закрыть меню» button in the topbar) must also keep Space so
 * keyboard users can activate them (LND-W9-RET-04).
 */
export function shouldLockScroll(input: ScrollLockInput): boolean {
  if (input.insideDrawer || input.insideDialog) return false;
  if (input.kind === "keydown") {
    if (input.key === " " && input.interactiveTarget) return false;
    return SCROLL_LOCK_KEYS.includes(input.key);
  }
  return true;
}

/**
 * What happened to the reading-line witness element since the drawer opened:
 * - `"held"`: the witness is still connected and its viewport `top` stayed within 1 px
 *   (confirmed browser scroll-anchoring compensation).
 * - `"moved"`: the witness is connected and its viewport `top` shifted by > 1 px
 *   (real content movement — must be restored).
 * - `"missing"`: no connected witness is available (cannot prove compensation;
 *   do not silently adopt an unknown offset).
 */
export type WitnessState = "held" | "moved" | "missing";

/** What the guard has to do with the offset of the page. */
export type ScrollGuardAction =
  | { kind: "hold" }
  | { kind: "adopt"; top: number }
  | { kind: "restore"; top: number };

/**
 * The offset of the page while the drawer is open.
 *
 * A scroll that happened anyway — a dragged scrollbar, a focused element, a
 * programmatic jump — has to be put back where it was. It is put back only as
 * far as the document can still reach: the document may have become shorter
 * while the menu was open, and the guard must not fight the browser over an
 * offset that does not exist any more.
 *
 * The offset alone does not tell a scroll of the reader apart from the
 * compensation of the browser: when a panel arrives above the reading
 * position, the browser moves the offset itself and leaves the content where
 * it was. Putting the offset back in that case would move the content — the
 * guard would cause the very jump it is there to prevent.
 *
 * When the witness confirms compensation (`witness === "held"`), the guard
 * adopts the compensated offset (`{ kind: "adopt", top }`) so a subsequent
 * external scroll restores to the compensated position rather than the stale
 * pre-compensation offset (LND-W9-RET-03). When the witness is missing
 * (`witness === "missing"`), the guard holds without updating `locked`.
 */
export function decideScrollGuard({
  current,
  locked,
  maxOffset,
  witness,
  witnessMoved,
}: {
  current: number;
  locked: number;
  maxOffset: number;
  witness?: WitnessState;
  /** @deprecated Prefer `witness: "held" | "moved" | "missing"`. */
  witnessMoved?: boolean;
}): ScrollGuardAction {
  const clampedMax = Math.max(0, maxOffset);
  const top = Math.max(0, Math.min(locked, clampedMax));
  const state: WitnessState =
    witness ?? (witnessMoved ? "moved" : "held");
  // A pixel of difference is not a drift: the browser reports fractional
  // offsets, and a fight over them would show as a trembling page.
  // However, if `locked` was clamped down to `top` (e.g., page shrank) while the
  // witness confirmed the reading line held, adopt `top` so a later page growth
  // does not restore the stale pre-shrink offset.
  if (Math.abs(current - top) <= 1) {
    if (state === "held" && Math.abs(locked - top) > 1) {
      return { kind: "adopt", top };
    }
    return { kind: "hold" };
  }

  if (state === "held") {
    return { kind: "adopt", top: Math.max(0, Math.min(current, clampedMax)) };
  }
  if (state === "missing") {
    return { kind: "hold" };
  }
  return { kind: "restore", top };
}
