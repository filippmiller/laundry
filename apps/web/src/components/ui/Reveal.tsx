import { motion, type Variants } from "motion/react";
import type { ReactNode } from "react";
import { cx } from "./cx";

const EASE = [0.22, 0.85, 0.28, 1] as const;

const containerVariants: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.045, delayChildren: 0.02 },
  },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.34, ease: EASE },
  },
};

/**
 * Staggered entrance for a group of siblings. Motion is suppressed
 * automatically for visitors who ask for reduced motion — `MotionConfig
 * reducedMotion="user"` at the app root handles that.
 */
export function Stagger({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "ul" | "section";
}) {
  const Component = motion[as];
  return (
    <Component
      className={cx(className)}
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {children}
    </Component>
  );
}

/** A single item inside a `Stagger` group. */
export function Reveal({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "li" | "ul" | "section" | "article" | "p";
}) {
  const Component = motion[as];
  return (
    <Component className={cx(className)} variants={itemVariants}>
      {children}
    </Component>
  );
}

/**
 * Cross-fades one workspace into the next when the operator switches role
 * or section. `mode="wait"` keeps the outgoing panel from overlapping the
 * incoming one, which keeps long tables readable.
 */
export function WorkspaceTransition({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.26, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}
