import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  iconOnly?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  className?: string;
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "primary",
  secondary: "secondary",
  ghost: "ghost",
  outline: "outline",
  quiet: "quiet",
  danger: "danger-btn",
};

/**
 * The single button primitive. Every variant maps onto the class names the
 * design system already defines, so legacy `<button className="primary">`
 * markup and this component render identically.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "ghost",
    size = "md",
    block = false,
    iconOnly = false,
    leadingIcon,
    trailingIcon,
    className,
    children,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        VARIANT_CLASS[variant],
        size !== "md" && `btn--${size}`,
        block && "btn--block",
        iconOnly && "btn--icon",
        className,
      )}
      {...rest}
    >
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
});
