"use client"

import { Component, type ReactNode } from "react"

type Props = {
  fallback?: (error: Error, reset: () => void) => ReactNode
  children: ReactNode
}

type State = {
  error: Error | null
}

/**
 * Module #67 — error boundary for the explore surface.
 * Catches render-time exceptions so a single malformed artifact card cannot
 * take down the whole page (zero unhandled tracebacks in production logs).
 */
export class ExploreErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  private reset = () => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset)
      }
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <p className="font-mono text-[10px] uppercase tracking-widest text-red-400/90">
            [ ERROR_BOUNDARY — FRAGMENT REJECTED ]
          </p>
          <button
            type="button"
            onClick={this.reset}
            className="inline-flex min-h-[36px] items-center border-2 border-cyan-400/50 bg-cyan-950/50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-cyan-100 transition-colors hover:border-cyan-300 hover:bg-cyan-900/40 hover:text-white"
          >
            Reintentar / Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
