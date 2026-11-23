import { cx } from "./cx";

export function Skeleton({
  variant = "text",
  width,
  className,
}: {
  variant?: "text" | "title" | "block";
  width?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "skeleton",
        variant === "text" && "skeleton--text",
        variant === "title" && "skeleton--title",
        variant === "block" && "skeleton--block",
        className,
      )}
      style={width ? { inlineSize: width } : undefined}
    />
  );
}

export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx("stack stack--tight", className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} />
      ))}
    </div>
  );
}
