'use client'

import { useColor } from 'color-thief-react'

type Props = {
    playerId: string
    username: string
    avatarUrl: string
    onClick: () => void
    disabled: boolean
    selected: boolean
}

export default function GuessWhoButton({ playerId, username, avatarUrl, onClick, disabled, selected }: Props) {
    const { data: dominantColor } = useColor(
        avatarUrl || '/placeholder-avatar.jpg',
        'rgbString',
        { crossOrigin: 'anonymous', quality: 10 }
    )

    const glow = dominantColor
        ? dominantColor.replace('rgb', 'rgba').replace(')', ', 0.75)')
        : 'rgba(29, 185, 84, 0.75)'

    const glowSoft = dominantColor
        ? dominantColor.replace('rgb', 'rgba').replace(')', ', 0.4)')
        : 'rgba(29, 185, 84, 0.4)'

    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`guess-who-btn${selected ? ' selected' : ''}`}
            style={selected ? { boxShadow: `0 0 0 2px ${glow}, 0 0 28px ${glowSoft}`, borderColor: glow } : {}}
        >
            <div className="guess-who-avatar-frame">
                <img
                    src={avatarUrl}
                    alt={username}
                    className="guess-who-avatar"
                />
            </div>
            <span
                className="guess-who-name"
                style={{
                    textShadow: `0 0 8px ${glow}, 0 0 18px ${glowSoft}`,
                    background: `linear-gradient(to top, ${glowSoft}, rgba(0,0,0,0.3))`,
                }}
            >
                {username}
            </span>
        </button>
    )
}
