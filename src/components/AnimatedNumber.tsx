'use client'

import { useEffect, useRef, useState } from 'react'

type Props = {
    value: number
    durationMs?: number
    decimals?: number
    className?: string
}

export default function AnimatedNumber({ value, durationMs = 650, decimals = 0, className }: Props) {
    const [displayValue, setDisplayValue] = useState(value)
    const previousValueRef = useRef(value)

    useEffect(() => {
        const startValue = previousValueRef.current
        const delta = value - startValue

        if (delta === 0) {
            previousValueRef.current = value
            return
        }

        let frameId = 0
        const startTime = performance.now()

        const tick = (now: number) => {
            const elapsed = now - startTime
            const progress = Math.min(1, elapsed / durationMs)
            const eased = 1 - Math.pow(1 - progress, 3)
            setDisplayValue(startValue + delta * eased)

            if (progress < 1) {
                frameId = requestAnimationFrame(tick)
            } else {
                previousValueRef.current = value
                setDisplayValue(value)
            }
        }

        frameId = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(frameId)
    }, [durationMs, value])

    return <span className={className}>{displayValue.toFixed(decimals)}</span>
}
