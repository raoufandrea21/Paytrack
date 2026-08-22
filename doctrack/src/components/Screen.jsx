import { useNavigate } from 'react-router-dom';

/**
 * Every screen is the same shape: a compact sticky header, a scrolling body,
 * and an optional sticky action bar pinned within thumb reach at the bottom.
 */
export default function Screen({ title, subtitle, back, actions, footer, children }) {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-full flex-col">
      <header
        className="sticky top-0 z-20 border-b border-slate-200/80 bg-slate-50/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90"
        style={{ paddingTop: 'var(--safe-top)' }}
      >
        <div className="mx-auto flex w-full max-w-lg items-center gap-2 px-3 py-2.5">
          {back ? (
            <button
              type="button"
              onClick={() => (typeof back === 'string' ? navigate(back) : navigate(-1))}
              className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-slate-600 hover:bg-slate-200/70 active:bg-slate-300/70 dark:text-slate-300 dark:hover:bg-slate-800"
              aria-label="Go back"
            >
              <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-bold tracking-tight">{title}</h1>
            {subtitle ? (
              <p className="truncate text-[13px] text-slate-500 dark:text-slate-400">{subtitle}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </div>
      </header>

      <main className="mx-auto w-full max-w-lg flex-1 px-3 pt-3" style={{ paddingBottom: footer ? '0.75rem' : 'calc(1.5rem + var(--safe-bottom))' }}>
        {children}
      </main>

      {footer ? (
        <div
          className="sticky bottom-0 z-20 border-t border-slate-200/80 bg-slate-50/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95"
          style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom))' }}
        >
          <div className="mx-auto w-full max-w-lg px-3 pt-3">{footer}</div>
        </div>
      ) : null}
    </div>
  );
}
