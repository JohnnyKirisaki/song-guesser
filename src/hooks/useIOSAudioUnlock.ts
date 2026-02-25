'use client'

import { useEffect, useRef } from 'react'

/**
 * iOS WebKit blocks all audio until the user explicitly interacts.
 * This hook unlocks audio on the first touch event by:
 * 1. Playing a silent AudioContext buffer (unlocks Web Audio API)
 * 2. Calling play/pause on the provided audio element (unlocks HTMLAudioElement)
 *
 * Safe to call on non-iOS — the listener adds/removes itself and does nothing
 * if audio is already playing or if AudioContext isn't supported.
 */
export function useIOSAudioUnlock(audioRef: React.RefObject<HTMLAudioElement | null>) {
    const unlockedRef = useRef(false)

    useEffect(() => {
        const unlock = async () => {
            if (unlockedRef.current) return
            unlockedRef.current = true

            // 1. Unlock Web Audio API via silent AudioContext
            try {
                const AudioContext = window.AudioContext || (window as any).webkitAudioContext
                if (AudioContext) {
                    const ctx = new AudioContext()
                    const buffer = ctx.createBuffer(1, 1, 22050)
                    const source = ctx.createBufferSource()
                    source.buffer = buffer
                    source.connect(ctx.destination)
                    source.start(0)
                    // Resume if suspended (required on iOS)
                    if (ctx.state === 'suspended') {
                        await ctx.resume()
                    }
                    console.log('[IOSAudioUnlock] AudioContext unlocked')
                }
            } catch (e) {
                console.warn('[IOSAudioUnlock] AudioContext unlock failed:', e)
            }

            // 2. Unlock the HTMLAudioElement directly
            const audio = audioRef.current
            if (audio) {
                try {
                    // Mute briefly, play, then immediately pause and restore volume
                    const prevVolume = audio.volume
                    audio.volume = 0
                    await audio.play()
                    audio.pause()
                    audio.volume = prevVolume
                    console.log('[IOSAudioUnlock] HTMLAudio element unlocked')
                } catch (e) {
                    // It's fine — may already be playing or have no src
                    console.warn('[IOSAudioUnlock] HTMLAudio unlock failed (may be ok):', e)
                }
            }

            // Remove listeners after first unlock
            document.removeEventListener('touchstart', unlock, true)
            document.removeEventListener('touchend', unlock, true)
            document.removeEventListener('click', unlock, true)
        }

        // Listen on capture phase so we catch the very first interaction
        document.addEventListener('touchstart', unlock, { capture: true, once: false, passive: true })
        document.addEventListener('touchend', unlock, { capture: true, once: false, passive: true })
        // Fallback for non-touch (mouse click — desktop / Android)
        document.addEventListener('click', unlock, { capture: true, once: false })

        return () => {
            document.removeEventListener('touchstart', unlock, true)
            document.removeEventListener('touchend', unlock, true)
            document.removeEventListener('click', unlock, true)
        }
    }, [audioRef])
}
