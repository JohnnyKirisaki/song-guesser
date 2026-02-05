'use client'

import React from 'react'
import { useVolume } from '@/context/VolumeContext'
import { Volume2, VolumeX } from 'lucide-react'

export default function VolumeSlider() {
    const { volume, setVolume } = useVolume()

    return (
        <div style={{
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            backgroundColor: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(10px)',
            padding: '10px 16px',
            borderRadius: '24px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            color: 'white',
            zIndex: 9999,
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
        }}>
            <button
                onClick={() => setVolume(volume === 0 ? 0.5 : 0)}
                style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', display: 'flex' }}
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
                    accentColor: '#1ed760',
                    cursor: 'pointer'
                }}
            />
        </div>
    )
}
