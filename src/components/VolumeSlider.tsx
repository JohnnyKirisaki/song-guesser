'use client'

import React from 'react'
import { useVolume } from '@/context/VolumeContext'
import { Volume2, VolumeX } from 'lucide-react'

export default function VolumeSlider() {
    const { volume, setVolume } = useVolume()

    return (
        <div className="glass-panel volume-slider-fixed" style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            padding: '12px 18px',
            borderRadius: '9999px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            zIndex: 9999,
        }}>
            <button
                onClick={() => setVolume(volume === 0 ? 0.5 : 0)}
                style={{ background: 'none', border: 'none', color: 'var(--text-main)', cursor: 'pointer', display: 'flex' }}
            >
                {volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
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
                    cursor: 'pointer'
                }}
            />
        </div>
    )
}
