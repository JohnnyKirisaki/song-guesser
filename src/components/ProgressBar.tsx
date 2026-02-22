export default function ProgressBar({ current, total }: { current: number, total: number }) {
    const percentage = Math.min(100, Math.max(0, (current / total) * 100))

    const isCritical = current <= 3 && current > 0;

    return (
        <div style={{ width: '100%', height: '10px', background: 'rgba(255,255,255,0.08)', borderRadius: '999px', overflow: 'hidden', boxShadow: 'inset 0 0 8px rgba(0,0,0,0.4)' }}>
            <div
                style={{
                    height: '100%',
                    width: `${percentage}%`,
                    background: isCritical
                        ? 'linear-gradient(90deg, #10853B, #0a4f21)'
                        : 'linear-gradient(90deg, var(--primary), #10853B)',
                    transition: 'width 0.1s linear, background 0.3s ease',
                    boxShadow: isCritical ? '0 0 12px rgba(16, 133, 59, 0.6)' : '0 0 12px rgba(46,242,160,0.6)'
                }}
            />
        </div>
    )
}
