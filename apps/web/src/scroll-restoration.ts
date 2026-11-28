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
 * @param viewportHeight how tall the visible part of the page is right now
 * @param attemptsLeft how many checks are still allowed
 */
export function decideScrollRestore(options: {
  target: number | null | undefined;
  currentScrollY: number;
  documentHeight: number;
  viewportHeight: number;
  attemptsLeft: number;
}): ScrollRestoreDecision {
  const { target, currentScrollY, documentHeight, viewportHeight, attemptsLeft } = options;
  // Nothing to remember: the workspace was never read.
  if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) return "skip";
  // The document must be able to hold the offset. The height of the document is not the measure
  // for that: the browser can only scroll to `height - viewport`, so an offset near the end of a
  // document that is barely taller than the target would be clamped to a smaller value and the
  // reader would land on a different line than the one they left.
  const reachable = Math.max(0, documentHeight - viewportHeight);
  if (reachable < target - SCROLL_RESTORE_TOLERANCE_PX) {
    return attemptsLeft > 0 ? "wait" : "skip";
  }
  // The reader has scrolled somewhere else in the meantime: their choice wins over the memory.
  if (Math.abs(currentScrollY) > SCROLL_RESTORE_TOLERANCE_PX) return "skip";
  return "restore";
}

export const DOCUMENT_SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "PageDown",
  "PageUp",
  "Home",
  "End",
  " ",
  "Spacebar",
]);

const SPACE_ACTIVATED_SELECTOR =
  'button, summary, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"]';

const ARROW_WIDGET_SELECTOR =
  '[role="tablist"], [role="listbox"], [role="menu"], [role="radiogroup"], [role="slider"], [role="spinbutton"], [role="combobox"]';

export type ScrollRestoreKeyCheck = {
  key: string;
  defaultPrevented?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  insideOverlay?: boolean;
  drawerOpen?: boolean;
  editableTarget?: boolean;
  spaceActivatedControl?: boolean;
  arrowWidgetControl?: boolean;
};

/**
 * Pure keyboard semantics predicate for cancelling pending scroll restoration (LND-W9-R3-04).
 *
 * - Space on a button/checkbox/tab (e.g. `.rail-toggle`) activates the control instead of
 *   scrolling the document, so it must NOT cancel restoration.
 * - Space / Shift+Space on a plain `<a href>` or document body scrolls the document and DOES
 *   cancel restoration.
 * - Input inside open overlays (drawer/dialog), editable fields, or already-handled events
 *   (`defaultPrevented`) does not cancel restoration.
 */
export function shouldKeyCancelScrollRestore(check: ScrollRestoreKeyCheck): boolean {
  if (check.defaultPrevented) return false;
  const isCtrlHomeEnd = Boolean(
    check.ctrlKey && !check.altKey && !check.metaKey && (check.key === "Home" || check.key === "End"),
  );
  if ((check.altKey || check.ctrlKey || check.metaKey) && !isCtrlHomeEnd) return false;
  if (!DOCUMENT_SCROLL_KEYS.has(check.key)) return false;
  if (check.insideOverlay || check.drawerOpen || check.editableTarget) return false;

  const isSpace = check.key === " " || check.key === "Spacebar";
  if (isSpace) {
    return !check.spaceActivatedControl;
  }

  const isArrowOrHomeEnd =
    check.key === "ArrowDown" ||
    check.key === "ArrowUp" ||
    check.key === "Home" ||
    check.key === "End";
  if (isArrowOrHomeEnd && check.arrowWidgetControl) {
    return false;
  }

  return true;
}

export function classifyKeyboardTarget(target: EventTarget | null): {
  insideOverlay: boolean;
  editableTarget: boolean;
  spaceActivatedControl: boolean;
  arrowWidgetControl: boolean;
} {
  if (!(target instanceof Element)) {
    return {
      insideOverlay: false,
      editableTarget: false,
      spaceActivatedControl: false,
      arrowWidgetControl: false,
    };
  }
  const htmlEl = target as HTMLElement;
  const editableTarget =
    Boolean(htmlEl.isContentEditable) ||
    Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
  return {
    insideOverlay: Boolean(target.closest(".rail, dialog[open]")),
    editableTarget,
    spaceActivatedControl: Boolean(target.closest(SPACE_ACTIVATED_SELECTOR)),
    arrowWidgetControl: Boolean(target.closest(ARROW_WIDGET_SELECTOR)),
  };
}
