import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "@/lib/errorReporter";

interface State {
  failed: boolean;
}

/**
 * If a page crashes, show a friendly "try again" screen instead of a blank
 * white page, and send the error to the admin "App errors" page.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[AppErrorBoundary] page crashed", error, info.componentStack);
    reportError(error, { componentStack: info.componentStack ?? undefined });
  }

  private reload = () => window.location.reload();

  private goHome = () => {
    window.location.href = "/";
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <img src="/pwa-192x192.png" alt="" className="h-16 w-16 rounded-2xl" />
        <h1 className="font-display text-xl font-bold">Something went wrong</h1>
        <p className="max-w-xs text-sm text-muted-foreground">Sorry about that. We've been told about it. Please try again.</p>
        <div className="flex gap-2">
          <button type="button" onClick={this.reload} className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground">
            Try again
          </button>
          <button type="button" onClick={this.goHome} className="rounded-full border px-5 py-2.5 text-sm font-semibold">
            Go home
          </button>
        </div>
      </div>
    );
  }
}
