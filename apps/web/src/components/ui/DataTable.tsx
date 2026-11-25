import type { ReactNode } from "react";
import { cx } from "./cx";

export type DataTableColumn<T> = {
  /** Stable column key. */
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  /** Right-align and use tabular figures — money, counts, timestamps. */
  numeric?: boolean;
  width?: string;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty,
  className,
  onRowClick,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  caption?: string;
  empty?: ReactNode;
  className?: string;
  onRowClick?: (row: T) => void;
}) {
  if (rows.length === 0 && empty) {
    return <>{empty}</>;
  }

  return (
    <div className={cx("table-wrap", className)}>
      <table className="clean-table">
        {caption ? <caption className="visually-hidden">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map(column => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { inlineSize: column.width } : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              className={onRowClick ? "clean-table__row--interactive" : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              /* No `role` on the row: a `<tr>` keeps the table semantics for
                 screen readers and cell navigation (MA-18). The row stays
                 focusable and reacts to Enter and Space. */
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map(column => (
                <td key={column.key} className={cx(column.numeric && "num")}>
                  {column.render(row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
