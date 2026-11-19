import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & {
  /** Required: an icon-only control must still expose an accessible name. */
  label: string;
  icon: ReactNode;
  variant?: "ghost" | "primary" | "secondary" | "quiet" | "danger";
  size?: "sm" | "md";
  className?: string;
};

const VARIANT_CLASS = {
  ghost: "ghost",
  primary: "primary",
  secondary: "secondary",
  quiet: "quiet",
  danger: "danger-btn",
} as const;

/** Square, icon-only button. The accessible name comes from `label`. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = "ghost", size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        VARIANT_CLASS[variant],
        "btn--icon",
        size === "sm" && "btn--sm",
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});
