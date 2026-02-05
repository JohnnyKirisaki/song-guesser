import type { Metadata } from 'next'
import './globals.css'
import { UserProvider } from '@/context/UserContext'
import { VolumeProvider } from '@/context/VolumeContext'
import VolumeSlider from '@/components/VolumeSlider'

export const metadata: Metadata = {
  title: 'BeatBattle',
  description: 'Multiplayer Music Guessing Game',
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
          </VolumeProvider>
        </UserProvider>
      </body>
    </html>
  )
}
