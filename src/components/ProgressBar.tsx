export default function ProgressBar({ current, total }: { current: number, total: number }) {
    const percentage = Math.min(100, Math.max(0, (current / total) * 100))

    return (
        <div style={{ width: '100%', height: '8px', background: '#333', borderRadius: '4px', overflow: 'hidden' }}>
            <div
                style={{
                    height: '100%',
                    width: `${percentage}%`,
                    background: 'var(--primary)',
                    transition: 'width 1s linear'
                }}
            />
        </div>
    )
}
