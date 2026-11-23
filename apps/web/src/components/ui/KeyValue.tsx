import type { ReactNode } from "react";
import { cx } from "./cx";

export type KeyValueRow = {
  label: ReactNode;
  value: ReactNode;
};

export function KeyValue({ rows, className }: { rows: KeyValueRow[]; className?: string }) {
  return (
    <dl className={cx("kv", className)}>
      {rows.map((row, index) => (
        <div className="kv__row" key={index}>
          <dt className="kv__key">{row.label}</dt>
          <dd className="kv__value">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
