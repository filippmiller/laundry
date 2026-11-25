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

/**
 * The heading level of a card header. A card that lives inside another card
 * must not repeat the level of its parent (MA-15 / MA-16): the default stays
 * at 2, a nested card asks for 3.
 */
export type HeadingLevel = 2 | 3 | 4 | 5 | 6;

export function CardHeader({
  title,
  subtitle,
  actions,
  eyebrow,
  headingLevel = 2,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  headingLevel?: HeadingLevel;
  className?: string;
}) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4" | "h5" | "h6";
  return (
    <div className={cx("panel-head", className)}>
      <div className="page-header__text">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <Heading className="panel-title">{title}</Heading>
        {subtitle ? <p className="panel-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="panel-actions">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("panel-body", className)}>{children}</div>;
}
