import type { ReactNode } from "react";
import { cx } from "./cx";

export function PageHeader({
  title,
  lede,
  eyebrow,
  actions,
  className,
}: {
  title: ReactNode;
  lede?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("page-header", className)}>
      <div className="page-header__text">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1 className="page-header__title">{title}</h1>
        {lede ? <p className="page-header__lede">{lede}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}
