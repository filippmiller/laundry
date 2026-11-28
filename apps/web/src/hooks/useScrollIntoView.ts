/**
 * Scroll and focus helpers for a result that appears below the fold.
 *
 * A master-detail view (a list of orders, a list of threads) renders the detail under the list.
 * When the user picks a row, the detail may sit a thousand pixels below the viewport: nothing
 * scrolls, nothing is focused, and the screen looks unchanged. These helpers make the result
 * visible and put the keyboard where the eye went.
 */

/** Does the user ask for reduced motion? Programmatic scrolls must respect it. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Brings a freshly rendered region into view and moves focus to its heading.
 *
 * The heading must carry `tabIndex={-1}` to be focusable programmatically; `preventScroll` keeps
 * the browser from jumping a second time after the explicit scroll.
 */
export function revealRegion(region: HTMLElement | null, options: { focus?: boolean } = {}): void {
  if (!region || typeof window === "undefined") return;
  const reduced = prefersReducedMotion();
  try {
    region.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  } catch {
    region.scrollIntoView({ block: "nearest" });
  }
  if (options.focus === false) return;
  const heading = region.querySelector<HTMLElement>("h2, h3, h4");
  const target = heading ?? region;
  if (target === region && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}
