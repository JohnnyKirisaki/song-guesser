'use client'

import React, { createContext, useContext, useEffect, useState } from 'react'

interface VolumeContextType {
    volume: number
    setVolume: (v: number) => void
}

const VolumeContext = createContext<VolumeContextType | undefined>(undefined)

export function VolumeProvider({ children }: { children: React.ReactNode }) {
    const [volume, setVolumeState] = useState(0.5)

    useEffect(() => {
        const saved = localStorage.getItem('global_volume')
        if (saved !== null) {
            setVolumeState(parseFloat(saved))
        }
    }, [])

    const setVolume = (v: number) => {
        const clamped = Math.max(0, Math.min(1, v))
        setVolumeState(clamped)
        localStorage.setItem('global_volume', clamped.toString())
    }

    return (
        <VolumeContext.Provider value={{ volume, setVolume }}>
            {children}
        </VolumeContext.Provider>
    )
}

export function useVolume() {
    const context = useContext(VolumeContext)
    if (context === undefined) {
        throw new Error('useVolume must be used within a VolumeProvider')
    }
    return context
}
