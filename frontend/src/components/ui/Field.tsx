import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react"

interface FieldShellProps {
  id: string
  label: string
  hint?: string
  error?: string
  className?: string
  children: ReactNode
}

const controlClasses =
  "block w-full min-h-11 rounded-sm border bg-surface px-3 text-base text-ink placeholder:text-ink-muted " +
  "transition-colors duration-150 hover:border-ink aria-invalid:border-danger aria-invalid:border-2"

function FieldShell({
  id,
  label,
  hint,
  error,
  className = "",
  children,
}: FieldShellProps) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mb-1.5 text-xs text-ink-muted">
          {hint}
        </p>
      )}
      {children}
      {error && (
        <p
          id={`${id}-error`}
          className="mt-1.5 text-sm font-medium text-danger"
        >
          {error}
        </p>
      )}
    </div>
  )
}

function describedBy(
  id: string,
  hint?: string,
  error?: string,
): string | undefined {
  const ids = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean)
  return ids.length ? ids.join(" ") : undefined
}

interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string
  hint?: string
  error?: string
  containerClassName?: string
}

export function TextField({
  label,
  hint,
  error,
  containerClassName,
  className = "",
  ...rest
}: TextFieldProps) {
  const id = useId()
  return (
    <FieldShell
      id={id}
      label={label}
      hint={hint}
      error={error}
      className={containerClassName}
    >
      <input
        id={id}
        className={`${controlClasses} border-field ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </FieldShell>
  )
}

interface SelectFieldProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  label: string
  hint?: string
  error?: string
  containerClassName?: string
  options: { value: string; label: string }[]
}

export function SelectField({
  label,
  hint,
  error,
  containerClassName,
  options,
  className = "",
  ...rest
}: SelectFieldProps) {
  const id = useId()
  return (
    <FieldShell
      id={id}
      label={label}
      hint={hint}
      error={error}
      className={containerClassName}
    >
      <select
        id={id}
        className={`${controlClasses} border-field pr-8 ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  )
}
