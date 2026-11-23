import { cx } from "./cx";

export function Meter({
  value,
  max = 100,
  tone = "default",
  label,
  className,
}: {
  value: number;
  max?: number;
  tone?: "default" | "warn" | "danger";
  /** Accessible name for the bar; rendered visually hidden. */
  label: string;
  className?: string;
}) {
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const percent = Math.round(ratio * 100);

  return (
    <div
      className={cx("meter", tone !== "default" && `meter--${tone}`, className)}
      role="progressbar"
      aria-label={label}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="meter__fill" style={{ inlineSize: `${percent}%` }} />
    </div>
  );
}
