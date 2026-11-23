import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./cx";

export type ToastKind = "ok" | "error" | "info";

const ICONS: Record<ToastKind, ReactNode> = {
  ok: <CheckCircle2 size={18} aria-hidden="true" />,
  error: <AlertCircle size={18} aria-hidden="true" />,
  info: <Info size={18} aria-hidden="true" />,
};

/** A single transient message. Announced politely by the region around it. */
export function Toast({
  kind = "ok",
  children,
  onDismiss,
  className,
}: {
  kind?: ToastKind;
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <motion.div
      layout
      className={cx("toast", `toast--${kind}`, className)}
      initial={{ opacity: 0, y: -10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: 0.22, ease: [0.22, 0.85, 0.28, 1] }}
    >
      <span className="toast__icon">{ICONS[kind]}</span>
      <span className="toast__text">{children}</span>
      {onDismiss ? (
        <button type="button" className="toast__close" aria-label="Закрыть уведомление" onClick={onDismiss}>
          <X size={15} aria-hidden="true" />
        </button>
      ) : null}
    </motion.div>
  );
}

/**
 * Top-right stack of transient messages. The region itself is a polite live
 * region so screen readers announce the message without stealing focus.
 */
export function ToastRegion({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("toast-region", className)} role="status" aria-live="polite">
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </div>
  );
}
