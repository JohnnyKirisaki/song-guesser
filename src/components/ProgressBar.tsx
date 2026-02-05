export default function ProgressBar({ current, total }: { current: number, total: number }) {
    const percentage = Math.min(100, Math.max(0, (current / total) * 100))

    return (
        <div style={{ width: '100%', height: '10px', background: 'rgba(255,255,255,0.08)', borderRadius: '999px', overflow: 'hidden', boxShadow: 'inset 0 0 8px rgba(0,0,0,0.4)' }}>
            <div
                style={{
                    height: '100%',
                    width: `${percentage}%`,
                    background: 'linear-gradient(90deg, var(--primary), var(--secondary))',
                    transition: 'width 0.1s linear',
                    boxShadow: '0 0 12px rgba(46,242,160,0.6)'
                }}
            />
        </div>
    )
}
