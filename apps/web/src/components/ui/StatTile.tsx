import type { ReactNode } from "react";
import { cx } from "./cx";

export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = "default",
  mono = true,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  /** `accent` tints the whole tile; the semantic tones colour the value only. */
  tone?: "default" | "accent" | "ok" | "warn" | "danger";
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cx("stat-tile", tone === "accent" && "stat-tile--accent", className)}>
      <div className="stat-tile__head">
        <span className="stat-label">{label}</span>
        {icon ? <span className="stat-tile__icon">{icon}</span> : null}
      </div>
      <strong className={cx("stat-value", !mono && "stat-value--plain", tone !== "default" && tone !== "accent" && `stat-value--${tone}`)}>
        {value}
      </strong>
      {hint ? <span className="stat-tile__hint">{hint}</span> : null}
    </div>
  );
}

export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("stats-grid", className)}>{children}</div>;
}
