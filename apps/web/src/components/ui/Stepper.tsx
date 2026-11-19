import { Check } from "lucide-react";
import { cx } from "./cx";

export type StepState = "done" | "current" | "todo";

export type Step = {
  id: string;
  label: string;
  state: StepState;
};

/**
 * A horizontal progress rail. Purely presentational — the authoritative
 * state always comes from the order lifecycle, never from a guess.
 */
export function Stepper({ steps, className }: { steps: Step[]; className?: string }) {
  return (
    <ol className={cx("stepper", className)}>
      {steps.map(step => (
        <li
          key={step.id}
          className={cx(
            "step-dot",
            step.state === "done" && "done",
            step.state === "current" && "current",
          )}
          aria-current={step.state === "current" ? "step" : undefined}
        >
          {step.state === "done" ? <Check size={12} aria-hidden="true" /> : null}
          {step.label}
        </li>
      ))}
    </ol>
  );
}
