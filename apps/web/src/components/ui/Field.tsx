import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { AlertCircle } from "lucide-react";
import { cx } from "./cx";

/* ------------------------------------------------------------------ */
/* Field — label, control, hint and error in one accessible unit       */
/* ------------------------------------------------------------------ */

export type FieldProps = {
  label: ReactNode;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  className?: string;
};

export function Field({ label, children, hint, error, optional = false, className }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = Boolean(error);
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cx("field", invalid && "field--error", className)}>
      <label htmlFor={id}>
        {label}
        {optional ? <span className="field__optional">— необязательно</span> : null}
      </label>
      {children({ id, describedBy, invalid })}
      {hint ? (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="field__error" id={errorId}>
          <AlertCircle size={14} aria-hidden="true" />
          {error}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  className?: string;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, optional, className, id, ...rest },
  ref,
) {
  if (!label) {
    return <input ref={ref} id={id} className={cx("input", className)} {...rest} />;
  }
  return (
    <Field label={label} hint={hint} error={error} optional={optional} className={className}>
      {({ id: fieldId, describedBy, invalid }) => (
        <input
          ref={ref}
          id={fieldId}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          {...rest}
        />
      )}
    </Field>
  );
});

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  className?: string;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, optional, className, id, children, ...rest },
  ref,
) {
  if (!label) {
    return (
      <select ref={ref} id={id} className={cx("select", className)} {...rest}>
        {children}
      </select>
    );
  }
  return (
    <Field label={label} hint={hint} error={error} optional={optional} className={className}>
      {({ id: fieldId, describedBy, invalid }) => (
        <select
          ref={ref}
          id={fieldId}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          {...rest}
        >
          {children}
        </select>
      )}
    </Field>
  );
});

/* ------------------------------------------------------------------ */
/* Textarea                                                            */
/* ------------------------------------------------------------------ */

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  className?: string;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, optional, className, id, ...rest },
  ref,
) {
  if (!label) {
    return <textarea ref={ref} id={id} className={cx("textarea", className)} {...rest} />;
  }
  return (
    <Field label={label} hint={hint} error={error} optional={optional} className={className}>
      {({ id: fieldId, describedBy, invalid }) => (
        <textarea
          ref={ref}
          id={fieldId}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          {...rest}
        />
      )}
    </Field>
  );
});

/* ------------------------------------------------------------------ */
/* Checkbox                                                            */
/* ------------------------------------------------------------------ */

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
  description?: ReactNode;
};

export function Checkbox({ label, description, className, id, ...rest }: CheckboxProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const descriptionId = description ? `${inputId}-description` : undefined;

  return (
    <label className={cx("check-row", className)} htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        aria-describedby={descriptionId}
        {...rest}
      />
      <span className="check-row__text">
        <span>{label}</span>
        {description ? (
          <span className="muted" id={descriptionId}>
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}
