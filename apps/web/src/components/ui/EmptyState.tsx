import type { ReactNode } from "react";
import { cx } from "./cx";

export function EmptyState({
  icon,
  title,
  text,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("empty-state", className)}>
      {icon ? <span className="empty-state__icon">{icon}</span> : null}
      <span className="empty-state__title">{title}</span>
      {text ? <span className="empty-state__text">{text}</span> : null}
      {action}
    </div>
  );
}
