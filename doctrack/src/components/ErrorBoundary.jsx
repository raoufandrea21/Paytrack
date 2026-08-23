import { Component } from 'react';

/**
 * Stops one broken screen from taking the whole app with it.
 *
 * React unmounts the entire tree when a render throws, so a mistake on the
 * document page does not show a broken document page — it shows a white
 * rectangle, on every screen, until someone thinks to reload. From the outside
 * that is indistinguishable from the app being gone, and there is nothing to
 * press.
 *
 * This catches it, keeps the rest of the app alive, and offers the two things
 * that actually help: go back, or reload. The documents are in the database and
 * are never at risk from a render error — saying so is most of the job, because
 * the fear is that they are not.
 *
 * A class, because an error boundary is the one thing React still has no hook
 * for.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[doctrack] a screen failed to render', error, info?.componentStack);
  }

  /**
   * Clear the error on any navigation, including one back to the same screen.
   *
   * Resetting by remounting on a key would throw away the whole route tree on
   * every navigation. Resetting here keeps the children mounted and still means
   * a screen that has since recovered — because the data changed, or the sync
   * brought down a fixed record — simply works when you return to it, rather
   * than showing the failure for the rest of the session.
   */
  componentDidUpdate(previous) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <span className="text-4xl" aria-hidden="true">😵</span>
        <h1 className="text-[19px] font-bold">This screen ran into a problem</h1>
        <p className="max-w-sm text-[15px] text-slate-600 dark:text-slate-400">
          Your documents are safe — they are stored on this device and nothing here can lose
          them. It is only this screen that failed to draw.
        </p>

        <div className="flex w-full max-w-xs flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              // Back to the dashboard, and clear the error so the app carries
              // on rather than needing a reload it might not survive either.
              window.location.hash = '#/';
              this.setState({ error: null });
            }}
            className="min-h-11 rounded-xl bg-indigo-600 px-4 text-[15px] font-semibold text-white hover:bg-indigo-500"
          >
            Back to the dashboard
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="min-h-11 rounded-xl bg-white px-4 text-[15px] font-semibold text-slate-800 ring-1 ring-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
          >
            Reload the app
          </button>
        </div>

        <details className="mt-2 w-full max-w-sm text-left">
          <summary className="cursor-pointer text-[13px] text-slate-500 dark:text-slate-400">
            What went wrong
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-xl bg-slate-100 p-3 text-[12px] text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {String(error?.message ?? error)}
          </pre>
        </details>
      </div>
    );
  }
}
