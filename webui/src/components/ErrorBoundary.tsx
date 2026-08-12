import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, LayoutDashboard, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render errors anywhere below the router and offers a styled
 * recovery screen instead of a blank page.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="grid min-h-[100dvh] w-full place-items-center bg-app-bg p-6 text-slate-100">
        <div className="panel-elev w-full max-w-lg animate-slide-up p-6 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-accent-red/15 text-accent-red ring-1 ring-accent-red/30">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-xl font-black tracking-tight text-white">Something went wrong</h1>
          <p className="mt-1 text-sm text-slate-400">
            The interface hit an unexpected error. Your server and render jobs are unaffected.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto break-words whitespace-pre-wrap rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-left font-mono text-[11px] leading-relaxed text-red-200 [overflow-wrap:anywhere]">
            {error.message}
          </pre>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
              <RotateCcw className="h-4 w-4" /> Reload
            </button>
            <Link to="/dashboard" className="btn-secondary" onClick={() => this.setState({ error: null })}>
              <LayoutDashboard className="h-4 w-4" /> Go to Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }
}
