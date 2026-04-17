'use client'

import React from 'react'

interface Props {
    children: React.ReactNode
    /** Optional override for the fallback UI. Receives the error + a reset fn. */
    fallback?: (error: Error, reset: () => void) => React.ReactNode
    /** Label used in logs — lets us tell GamePage vs Recap apart in telemetry. */
    boundaryName?: string
}

interface State {
    error: Error | null
}

/**
 * Error boundary for the game/recap subtree. Without it, any uncaught render
 * error (bad playlist shape, audio crash, etc.) would blank the whole screen
 * and trap the user mid-game. The fallback offers a "Return to lobby" escape
 * hatch so they can rejoin via the room code.
 *
 * Must be a class component — React has no hook-based error boundary API.
 */
export default class GameErrorBoundary extends React.Component<Props, State> {
    constructor(props: Props) {
        super(props)
        this.state = { error: null }
    }

    static getDerivedStateFromError(error: Error): State {
        return { error }
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        const label = this.props.boundaryName || 'GameErrorBoundary'
        // eslint-disable-next-line no-console
        console.error(`[${label}] Render error caught:`, error, info)
    }

    reset = () => {
        this.setState({ error: null })
    }

    render() {
        if (this.state.error) {
            if (this.props.fallback) {
                return this.props.fallback(this.state.error, this.reset)
            }
            return (
                <div
                    role="alert"
                    className="glass-panel"
                    style={{
                        maxWidth: '520px',
                        margin: '80px auto',
                        padding: '32px',
                        textAlign: 'center',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '16px'
                    }}
                >
                    <h2 style={{ margin: 0, fontFamily: 'Syne, sans-serif' }}>Something broke.</h2>
                    <p style={{ color: '#aaa', margin: 0, fontSize: '0.95rem' }}>
                        The game hit an unexpected error. Your friends are still connected — rejoin via the room code to continue.
                    </p>
                    <details style={{ textAlign: 'left', fontSize: '0.8rem', color: '#666' }}>
                        <summary style={{ cursor: 'pointer' }}>Details</summary>
                        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {this.state.error.message}
                        </pre>
                    </details>
                    <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '8px' }}>
                        <button
                            className="btn-glass"
                            onClick={this.reset}
                            aria-label="Try to recover without leaving the game"
                        >
                            Retry
                        </button>
                        <button
                            className="btn-primary"
                            onClick={() => {
                                if (typeof window !== 'undefined') window.location.href = '/'
                            }}
                            aria-label="Return to lobby"
                        >
                            Return to lobby
                        </button>
                    </div>
                </div>
            )
        }

        return this.props.children
    }
}
