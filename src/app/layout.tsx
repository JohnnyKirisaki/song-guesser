import type { Metadata, Viewport } from 'next'
import './globals-holo.css'
import { UserProvider } from '@/context/UserContext'
import { VolumeProvider } from '@/context/VolumeContext'
import VolumeSlider from '@/components/VolumeSlider'
import IOSDetector from '@/components/IOSDetector'
import RouteTransition from '@/components/RouteTransition'

export const metadata: Metadata = {
  title: 'BeatBattle',
  description: 'Multiplayer Music Guessing Game',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover', // Required for env(safe-area-inset-*) to work on iOS
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <IOSDetector />
        <UserProvider>
          <VolumeProvider>
            <RouteTransition>{children}</RouteTransition>
            <VolumeSlider />
            <div className="noise-overlay" />
          </VolumeProvider>
        </UserProvider>
      </body>
    </html>
  )
}
