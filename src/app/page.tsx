'use client'

import { useUser } from '@/context/UserContext'
import Onboarding from '@/components/Onboarding'
import MainMenu from '@/components/MainMenu'
import { Loader2 } from 'lucide-react'

export default function Home() {
  const { user, profile, isLoading } = useUser()

  if (isLoading) {
    return (
      <main className="flex-center" style={{ height: '100vh' }}>
        <Loader2 className="animate-spin" size={48} color="var(--primary)" />
        <style jsx global>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          .animate-spin {
            animation: spin 1s linear infinite;
          }
        `}</style>
      </main>
    )
  }

  return (
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {!profile ? (
        <div className="flex-center" style={{ flex: 1 }}>
          <Onboarding />
        </div>
      ) : (
        <MainMenu
          onCreateRoom={() => { }}
          onJoinRoom={() => { }}
        />
      )}
    </main>
  )
}
