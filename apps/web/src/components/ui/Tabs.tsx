import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";

export type TabItem = {
  id: string;
  label: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
};

/**
 * Tab bar following the WAI-ARIA tabs pattern: roving tabindex, arrow-key
 * navigation, and a single tab stop for the whole strip.
 */
export function Tabs({
  items,
  value,
  onChange,
  label,
  idPrefix,
  className,
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  /** Optional shared scope prefix (from `useId()`) when pairing with `<TabPanel>`. */
  idPrefix?: string;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const prefix = idPrefix ?? generatedId;

  // The strip scrolls sideways on narrow screens, so the active tab has to be
  // brought back into view when it changes (MA-02).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const tab = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(value)}"]`);
    if (!tab) return;
    const listRect = list.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    if (tabRect.left >= listRect.left && tabRect.right <= listRect.right) return;
    const delta = (tabRect.left + tabRect.right) / 2 - (listRect.left + listRect.right) / 2;
    const reduced =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;
    list.scrollTo({ left: list.scrollLeft + delta, behavior: reduced ? "auto" : "smooth" });
  }, [value]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    const enabled = items.filter(item => !item.disabled);
    if (enabled.length === 0) return;
    const currentIndex = enabled.findIndex(item => item.id === value);
    let nextIndex = currentIndex;

    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % enabled.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = enabled.length - 1;

    const next = enabled[nextIndex];
    onChange(next.id);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(next.id)}"]`)
      ?.focus();
  }

  return (
    <div
      ref={listRef}
      className={cx("tab-bar", className)}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {items.map(item => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${prefix}-tab-${item.id}`}
            data-tab-id={item.id}
            aria-selected={selected}
            aria-controls={`${prefix}-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            className={cx("tab-btn", selected && "active")}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  id,
  active,
  idPrefix,
  children,
  className,
}: {
  id: string;
  active: boolean;
  /** Shared scope prefix matching the paired `<Tabs idPrefix={...} />`. */
  idPrefix?: string;
  children: ReactNode;
  className?: string;
}) {
  const generatedId = useId();
  const prefix = idPrefix ?? generatedId;
  if (!active) return null;
  return (
    <div
      role="tabpanel"
      id={`${prefix}-panel-${id}`}
      aria-labelledby={`${prefix}-tab-${id}`}
      tabIndex={0}
      className={cx("tab-panel", className)}
    >
      {children}
    </div>
  );
}

/** Compact segmented control — a denser alternative to the tab strip. */
export function Segmented({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={cx("segmented", className)} role="group" aria-label={label}>
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          className="segmented__item"
          aria-pressed={item.id === value}
          disabled={item.disabled}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
