'use client'

import React, { useState } from 'react'
import { useVolume } from '@/context/VolumeContext'
import { Volume2, VolumeX } from 'lucide-react'

export default function VolumeSlider() {
    const { volume, setVolume } = useVolume()
    const [isOpen, setIsOpen] = useState(false)

    return (
        <div
            className="glass-panel"
            style={{
                position: 'fixed',
                bottom: '24px',
                right: '24px',
                zIndex: 9999,
                display: 'flex',
                alignItems: 'center',
                borderRadius: '9999px',
                padding: '4px',
                gap: '0',
            }}
            onMouseEnter={() => setIsOpen(true)}
            onMouseLeave={() => setIsOpen(false)}
        >
            {/* Slider — width animates */}
            <div style={{
                overflow: 'hidden',
                maxWidth: isOpen ? '120px' : '0px',
                opacity: isOpen ? 1 : 0,
                transition: 'max-width 0.3s cubic-bezier(0.22,1,0.36,1), opacity 0.2s ease',
                display: 'flex',
                alignItems: 'center',
                paddingLeft: isOpen ? '14px' : '0',
            }}>
                <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    style={{
                        width: '100px',
                        accentColor: 'var(--primary)',
                        cursor: 'pointer',
                        flexShrink: 0,
                    }}
                />
            </div>

            {/* Speaker icon — always visible */}
            <button
                onClick={() => setVolume(volume === 0 ? 0.5 : 0)}
                style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-main)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '44px',
                    height: '44px',
                    flexShrink: 0,
                }}
            >
                {volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
        </div>
    )
}
