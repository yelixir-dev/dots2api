import { useEffect, useId, useState } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  MouseEvent,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { Check, ChevronDown, CircleCheck, CircleX, Copy, Eye, EyeOff, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { cx, formatAbsolute, formatClock, formatRelative } from "../lib/format";

export type Tone = "ok" | "warn" | "danger" | "accent" | "neutral";
export type NoticeTone = "info" | "ok" | "warn" | "danger";

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function Spinner() {
  return <LoaderCircle className="spinner" aria-hidden="true" />;
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: "md" | "sm" | undefined;
  readonly icon?: ReactNode;
  readonly loading?: boolean | undefined;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  loading = false,
  className,
  children,
  onClick,
  type = "button",
  ...rest
}: ButtonProps) {
  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  }
  return (
    <button
      {...rest}
      type={type}
      className={cx("btn", `btn--${variant}`, size === "sm" && "btn--sm", className)}
      onClick={handleClick}
      aria-disabled={loading ? true : rest["aria-disabled"]}
      aria-busy={loading || undefined}
    >
      {loading ? <Spinner /> : icon}
      {children === undefined || children === null || children === false ? null : <span className="btn__label">{children}</span>}
    </button>
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  readonly label: string;
  readonly icon: ReactNode;
}

export function IconButton({ label, icon, className, type = "button", title, ...rest }: IconButtonProps) {
  return (
    <button {...rest} type={type} className={cx("icon-btn", className)} aria-label={label} title={title ?? label}>
      {icon}
    </button>
  );
}

export function StatusBadge({ tone, pulse = false, children }: { readonly tone: Tone; readonly pulse?: boolean | undefined; readonly children: ReactNode }) {
  return (
    <span className={cx("badge", `badge--${tone}`)}>
      <span className={cx("signal", pulse && "signal--pulse")} aria-hidden="true" />
      {children}
    </span>
  );
}

interface SwitchProps {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
  readonly loading?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
}

export function Switch({ checked, label, onChange, loading = false, disabled = false, title }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={loading || undefined}
      title={title}
      disabled={disabled}
      onClick={() => {
        if (!loading) onChange(!checked);
      }}
    >
      <span className="switch__knob" aria-hidden="true">
        {loading ? <LoaderCircle className="spinner" /> : null}
      </span>
    </button>
  );
}

export interface ControlProps {
  readonly id: string;
  readonly "aria-describedby": string | undefined;
  readonly "aria-invalid": true | undefined;
}

interface FieldProps {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null | undefined;
  readonly mark?: "required" | "optional" | null | undefined;
  readonly children: (control: ControlProps) => ReactNode;
}

export function Field({ label, hint, error, mark, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : "", hint ? hintId : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <div className="field__head">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        {mark === "required" ? <span className="field__mark field__mark--required">필수</span> : null}
        {mark === "optional" ? <span className="field__mark">선택</span> : null}
      </div>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error ? (
        <p className="field__error" id={errorId}>
          <TriangleAlert aria-hidden="true" />
          {error}
        </p>
      ) : null}
      {hint ? (
        <div className="field__hint" id={hintId}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function RevealToggle({ shown, onToggle }: { readonly shown: boolean; readonly onToggle: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn secret__toggle"
      aria-label="값 보기"
      aria-pressed={shown}
      title={shown ? "값 숨기기" : "값 보기"}
      onClick={onToggle}
    >
      {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
    </button>
  );
}

export function SecretInput({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  return (
    <div className="secret">
      <input
        {...props}
        type={shown ? "text" : "password"}
        className={cx("input", "secret__control", className)}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <RevealToggle shown={shown} onToggle={() => setShown((value) => !value)} />
    </div>
  );
}

export function SecretArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="secret secret--area">
      <textarea
        {...props}
        className={cx("input", "input--area", "secret__control", !shown && "input--masked", className)}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <RevealToggle shown={shown} onToggle={() => setShown((value) => !value)} />
    </div>
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="select">
      <select {...props} className={cx("input", "select__control", className)}>
        {children}
      </select>
      <ChevronDown className="select__icon" aria-hidden="true" />
    </div>
  );
}

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count?: number | undefined;
}

interface SegmentedProps<T extends string> {
  readonly legend: string;
  readonly value: T;
  readonly options: ReadonlyArray<SegmentOption<T>>;
  readonly onChange: (value: T) => void;
  readonly variant?: "track" | "chips" | undefined;
}

export function Segmented<T extends string>({ legend, value, options, onChange, variant = "track" }: SegmentedProps<T>) {
  const name = useId();
  return (
    <fieldset className={cx("segmented", `segmented--${variant}`)}>
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="segmented__item">
          <input
            className="segmented__input"
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          <span className="segmented__text">
            {option.label}
            {option.count === undefined ? null : <span className="segmented__count">{option.count}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

const noticeIcons = { info: Info, ok: CircleCheck, warn: TriangleAlert, danger: CircleX } as const;

interface NoticeProps {
  readonly tone?: NoticeTone | undefined;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}

export function Notice({ tone = "info", title, children, action }: NoticeProps) {
  const Icon = noticeIcons[tone];
  return (
    <div className={cx("notice", `notice--${tone}`)}>
      <Icon className="notice__icon" aria-hidden="true" />
      <div className="notice__body">
        {title ? <p className="notice__title">{title}</p> : null}
        {children ? <div className="notice__text">{children}</div> : null}
      </div>
      {action ? <div className="notice__action">{action}</div> : null}
    </div>
  );
}

interface EmptyStateProps {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}

export function EmptyState({ icon, title, children, action }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">
        {icon}
      </div>
      <p className="empty__title">{title}</p>
      {children ? <p className="empty__text">{children}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}

export function CopyButton({ value, label = "복사" }: { readonly value: string; readonly label?: string | undefined }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon={state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        onClick={() => void copy()}
      >
        {state === "copied" ? "복사됨" : state === "failed" ? "복사 실패" : label}
      </Button>
      <span className="sr-only" role="status">
        {state === "copied" ? "클립보드에 복사했습니다." : state === "failed" ? "복사하지 못했습니다. 직접 선택해 복사하세요." : ""}
      </span>
    </>
  );
}

export function CodeBlock({ caption, code, copyValue }: { readonly caption: string; readonly code: string; readonly copyValue?: string | undefined }) {
  return (
    <figure className="code">
      <figcaption className="code__head">
        <span className="code__caption">{caption}</span>
        <CopyButton value={copyValue ?? code} />
      </figcaption>
      <pre className="code__body">
        <code>{code}</code>
      </pre>
    </figure>
  );
}

export function Elapsed({ since }: { readonly since: number }) {
  const now = useNow(1000);
  return <span className="tabular">{Number.isFinite(since) ? formatClock(now - since) : "—"}</span>;
}

export function TimeText({ iso, now }: { readonly iso: string; readonly now: number }) {
  return (
    <time dateTime={iso} title={formatAbsolute(iso)}>
      {formatRelative(iso, now)}
    </time>
  );
}

export function SkeletonRows({ count = 3 }: { readonly count?: number | undefined }) {
  const [rows] = useState(() => Array.from({ length: count }, () => crypto.randomUUID()));
  return (
    <div className="skeleton" role="status" aria-label="불러오는 중">
      {rows.map((id) => (
        <div key={id} className="skeleton__row">
          <span className="skeleton__bar" />
          <span className="skeleton__bar skeleton__bar--short" />
        </div>
      ))}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { readonly title: string; readonly description: ReactNode; readonly actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head__text">
        <h1 className="page-title" id="page-title" tabIndex={-1}>
          {title}
        </h1>
        <p className="page-desc">{description}</p>
      </div>
      {actions ? <div className="page-head__actions">{actions}</div> : null}
    </header>
  );
}

export function SectionHead({ id, title, children }: { readonly id?: string | undefined; readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className="section-head">
      <h2 className="section-title" id={id}>
        {title}
      </h2>
      {children ? <div className="section-head__aside">{children}</div> : null}
    </div>
  );
}
