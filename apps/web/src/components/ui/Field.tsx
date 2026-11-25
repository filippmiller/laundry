import {
  forwardRef,
  useId,
  type HTMLAttributes,
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

/**
 * Keyboard semantics of a control. The primitives fill in a sane default
 * from the type of the field, so every form can set the hints per field
 * without repeating the same markup (MA-24).
 */
export type ControlSemantics = {
  /** Virtual keyboard: `tel`, `numeric`, `decimal`, `email`, … */
  inputMode?: HTMLAttributes<HTMLElement>["inputMode"];
  /** Browser autofill hint: `tel`, `email`, `one-time-code`, … */
  autoComplete?: string;
  /** Label of the action key of the virtual keyboard. */
  enterKeyHint?: HTMLAttributes<HTMLElement>["enterKeyHint"];
};

const INPUT_MODE_BY_TYPE: Record<string, NonNullable<HTMLAttributes<HTMLElement>["inputMode"]>> = {
  tel: "tel",
  email: "email",
  url: "url",
  search: "search",
  number: "decimal",
};

const AUTOCOMPLETE_BY_TYPE: Record<string, string> = {
  tel: "tel",
  email: "email",
  "one-time-code": "one-time-code",
};

export type InputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  keyof ControlSemantics
> &
  ControlSemantics & {
    label?: ReactNode;
    hint?: ReactNode;
    error?: ReactNode;
    optional?: boolean;
    className?: string;
  };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, optional, className, id, type, inputMode, autoComplete, enterKeyHint, ...rest },
  ref,
) {
  const semantics: ControlSemantics = {
    inputMode: inputMode ?? INPUT_MODE_BY_TYPE[type ?? "text"],
    autoComplete: autoComplete ?? AUTOCOMPLETE_BY_TYPE[type ?? ""],
    enterKeyHint: enterKeyHint ?? "done",
  };

  if (!label) {
    return <input ref={ref} id={id} type={type} className={cx("input", className)} {...semantics} {...rest} />;
  }
  return (
    <Field label={label} hint={hint} error={error} optional={optional} className={className}>
      {({ id: fieldId, describedBy, invalid }) => (
        <input
          ref={ref}
          id={fieldId}
          type={type}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          {...semantics}
          {...rest}
        />
      )}
    </Field>
  );
});

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

export type SelectProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  keyof ControlSemantics
> &
  ControlSemantics & {
    label?: ReactNode;
    hint?: ReactNode;
    error?: ReactNode;
    optional?: boolean;
    className?: string;
  };

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    label,
    hint,
    error,
    optional,
    className,
    id,
    children,
    // `inputMode` and `enterKeyHint` describe a text field: a native select has
    // no keyboard of its own, so only the autofill hint reaches the element.
    inputMode: _inputMode,
    enterKeyHint: _enterKeyHint,
    ...rest
  },
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
