'use client'

import { ReactNode } from 'react'
import { usePathname } from 'next/navigation'

export default function RouteTransition({ children }: { children: ReactNode }) {
    const pathname = usePathname()

    return (
        <div key={pathname} className="route-shell">
            {children}
        </div>
    )
}
