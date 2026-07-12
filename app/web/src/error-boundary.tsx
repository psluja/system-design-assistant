import { Component, type ErrorInfo, type ReactNode } from 'react';

// A last-resort ERROR BOUNDARY around the whole app. Without it, a single throw in ANY render/useMemo unmounts the
// React root — the canvas (and everything) vanishes to a blank page that only a full reload restores (the bug the
// owner hit on add / Tidy / Improve). With it, a transient render error becomes RECOVERABLE and DIAGNOSABLE:
//   • the design itself is never lost — it lives in Studio state + IndexedDB, not in the crashed view;
//   • "Recover" re-mounts the subtree, which succeeds whenever the bad state was transient (an async worker result
//     racing a graph edit, the usual cause) — no full-page reload, no lost scroll/zoom on the rest of the shell;
//   • the exact error + component stack are shown on screen AND logged to the console, so the root cause is captured
//     the first time it happens instead of leaving only "everything disappeared".
// This is the right architecture for a canvas app (React's own recommendation), not a band-aid: the app must never
// blank-out the user's work on a recoverable error.

interface Props {
  readonly children: ReactNode;
}
interface State {
  readonly error: Error | null;
  /** Bumped on Recover so children fully re-mount (fresh memo state), not just re-render. */
  readonly resetKey: number;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the full stack in the console even after Recover clears the on-screen panel — the durable diagnostic.
    // eslint-disable-next-line no-console
    console.error('[SDA] render crash caught by ErrorBoundary:', error, '\ncomponent stack:', info.componentStack);
  }

  private recover = (): void => {
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }));
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="crash">
          <div className="crash-box">
            <h2>Something broke while drawing the canvas</h2>
            <p>
              Your design is safe — it is saved locally, not in this view. Try <b>Recover</b> first (it usually works
              when the error was a passing glitch). If it comes back, <b>Reload</b> restores everything from the last save.
            </p>
            <div className="crash-actions">
              <button className="btn primary" onClick={this.recover}>Recover</button>
              <button className="btn" onClick={() => window.location.reload()}>Reload page</button>
            </div>
            <details className="crash-detail">
              <summary>Technical detail (please share this if it keeps happening)</summary>
              <pre>{error.message}{'\n\n'}{error.stack}</pre>
            </details>
          </div>
        </div>
      );
    }
    // The key forces a full re-mount of the subtree on Recover, so a stale memo can never survive the reset.
    return <div key={this.state.resetKey} style={{ display: 'contents' }}>{this.props.children}</div>;
  }
}
