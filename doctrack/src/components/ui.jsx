import { Link } from 'react-router-dom';

/**
 * The handful of primitives every screen shares. Sizes are set for thumbs:
 * nothing tappable is under 44px, and primary actions live at the bottom.
 */

const VARIANTS = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700 disabled:bg-indigo-300 dark:disabled:bg-indigo-900',
  secondary:
    'bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 active:bg-slate-100 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700 dark:hover:bg-slate-700',
  ghost:
    'text-slate-600 hover:bg-slate-100 active:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800',
  danger:
    'bg-red-600 text-white hover:bg-red-500 active:bg-red-700 disabled:bg-red-300 dark:disabled:bg-red-900',
};

const BASE =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-semibold transition-colors disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500';

export function Button({ variant = 'primary', className = '', as, to, ...props }) {
  const classes = `${BASE} ${VARIANTS[variant]} ${className}`;
  if (as === 'link') return <Link to={to} className={classes} {...props} />;
  return <button type="button" className={classes} {...props} />;
}

export function Card({ className = '', ...props }) {
  return (
    <div
      className={`rounded-2xl bg-white ring-1 ring-slate-200/80 dark:bg-slate-900 dark:ring-slate-800 ${className}`}
      {...props}
    />
  );
}

export function Field({ label, hint, hintTone, error, children, htmlFor, action }) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-300">{label}</span>
        {action}
      </div>
      {children}
      {error ? (
        <p className="mt-1 text-[13px] text-red-600 dark:text-red-400">{error}</p>
      ) : hint ? (
        <p
          className={`mt-1 text-[13px] ${
            hintTone === 'review'
              ? 'font-semibold text-amber-700 dark:text-amber-400'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          {hint}
        </p>
      ) : null}
    </label>
  );
}

const CONTROL =
  'w-full min-h-11 rounded-xl px-3 py-2.5 text-[16px] text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 focus:outline-none dark:text-slate-100';

/**
 * Ring width and colour are picked here rather than layered on through
 * className, because `ring-2 ring-amber-400` appended after `ring-1
 * ring-slate-300` sets the same custom properties and the winner would come
 * down to stylesheet order.
 */
const CONTROL_TONES = {
  default: 'bg-white ring-1 ring-slate-300 dark:bg-slate-800 dark:ring-slate-700',
  review: 'bg-amber-50 ring-2 ring-amber-400 dark:bg-amber-950/40 dark:ring-amber-500',
  error: 'bg-red-50 ring-2 ring-red-400 dark:bg-red-950/40 dark:ring-red-500',
};

const control = (tone, className) =>
  `${CONTROL} ${CONTROL_TONES[tone] ?? CONTROL_TONES.default} ${className}`;

export function Input({ className = '', tone, ...props }) {
  return <input className={control(tone, className)} {...props} />;
}

export function Select({ className = '', tone, ...props }) {
  return <select className={control(tone, className)} {...props} />;
}

export function Textarea({ className = '', tone, ...props }) {
  return <textarea className={`${control(tone, className)} min-h-24`} {...props} />;
}

/** Coloured expiry pill used on cards, rows and the detail header. */
export function UrgencyChip({ urgency, children, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold ${urgency.chip} ${className}`}
    >
      <span className={`size-1.5 rounded-full ${urgency.dot}`} aria-hidden="true" />
      {children}
    </span>
  );
}

export function Banner({ tone = 'info', title, children, className = '' }) {
  const tones = {
    info: 'bg-slate-100 text-slate-700 dark:bg-slate-800/70 dark:text-slate-300',
    ok: 'bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:ring-emerald-900',
    warn: 'bg-amber-50 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-900',
    error:
      'bg-red-50 text-red-900 ring-1 ring-red-200 dark:bg-red-950/50 dark:text-red-200 dark:ring-red-900',
  };
  return (
    <div className={`rounded-xl px-3.5 py-3 text-[14px] ${tones[tone]} ${className}`} role={tone === 'error' ? 'alert' : undefined}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? 'mt-1' : ''}>{children}</div> : null}
    </div>
  );
}

export function Spinner({ className = 'size-5' }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

export function EmptyState({ icon, title, children }) {
  return (
    <div className="px-6 py-14 text-center">
      <div className="text-4xl" aria-hidden="true">{icon}</div>
      <p className="mt-3 text-[15px] font-semibold text-slate-800 dark:text-slate-200">{title}</p>
      {children ? (
        <div className="mx-auto mt-2 max-w-xs text-[14px] text-slate-500 dark:text-slate-400">
          {children}
        </div>
      ) : null}
    </div>
  );
}
