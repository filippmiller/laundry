import type { ReactNode } from "react";
import { cx } from "./cx";

export type CardProps = {
  children: ReactNode;
  className?: string;
  /** Adds a pointer affordance — use with a real interactive element inside. */
  interactive?: boolean;
  selected?: boolean;
  quiet?: boolean;
  flush?: boolean;
  as?: "div" | "section" | "article" | "li";
};

export function Card({
  children,
  className,
  interactive = false,
  selected = false,
  quiet = false,
  flush = false,
  as: Tag = "div",
}: CardProps) {
  return (
    <Tag
      className={cx(
        "card",
        interactive && "card--interactive",
        selected && "card--selected",
        quiet && "card--quiet",
        flush && "card--flush",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  eyebrow,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("panel-head", className)}>
      <div className="page-header__text">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h2 className="panel-title">{title}</h2>
        {subtitle ? <p className="panel-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="panel-actions">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("panel-body", className)}>{children}</div>;
}
