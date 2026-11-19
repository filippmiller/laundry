import type { ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "dark";

const TONE_CLASS: Record<BadgeTone, string | undefined> = {
  neutral: undefined,
  ok: "ok",
  warn: "warn",
  danger: "danger",
  info: "info",
  accent: "accent",
  dark: "dark",
};

export function Badge({
  tone = "neutral",
  dot = false,
  large = false,
  icon,
  children,
  className,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  large?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx("badge", TONE_CLASS[tone], dot && "badge--dot", large && "badge--lg", className)}>
      {dot ? <span className="badge__dot" aria-hidden="true" /> : null}
      {icon}
      {children}
    </span>
  );
}
