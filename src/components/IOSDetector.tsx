'use client'

import { useEffect } from 'react'

/**
 * Detects iOS devices and adds an `ios` class to <html>.
 * All iOS-specific CSS overrides target `.ios` prefix.
 *
 * Why UA sniffing? `@supports` can't target iOS specifically.
 * This is the only reliable client-side approach.
 */
export default function IOSDetector() {
    useEffect(() => {
        const isIOS =
            /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            // iPadOS 13+ reports as "Macintosh" — check for touch support
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

        if (isIOS) {
            document.documentElement.classList.add('ios')
        }
    }, [])

    return null
}
