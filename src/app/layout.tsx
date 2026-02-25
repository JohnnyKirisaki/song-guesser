import type { Metadata, Viewport } from 'next'
import './globals-holo.css'
import { UserProvider } from '@/context/UserContext'
import { VolumeProvider } from '@/context/VolumeContext'
import VolumeSlider from '@/components/VolumeSlider'

export const metadata: Metadata = {
  title: 'BeatBattle',
  description: 'Multiplayer Music Guessing Game',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <UserProvider>
          <VolumeProvider>
            {children}
            <VolumeSlider />
            <div className="noise-overlay" />
          </VolumeProvider>
        </UserProvider>
      </body>
    </html>
  )
}
