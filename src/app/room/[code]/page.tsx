'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { db } from '@/lib/firebase'
import { ref, get, set, onDisconnect, update } from 'firebase/database'
import { useUser } from '@/context/UserContext'
import Lobby from '@/components/Lobby'
import Onboarding from '@/components/Onboarding'

export default function RoomLobby() {
    const params = useParams()
    const code = params.code as string
    const { profile } = useUser()
    const router = useRouter()
    const [loading, setLoading] = useState(true)
    const [roomData, setRoomData] = useState<any>(null)

    useEffect(() => {
        const joinRoom = async () => {
            if (!code || !profile) return

            const roomRef = ref(db, `rooms/${code}`)
            const playerRef = ref(db, `rooms/${code}/players/${profile.id}`)

            try {
                // 1. Check if room exists
                const snapshot = await get(roomRef)
                if (!snapshot.exists()) {
                    alert('Room not found')
                    router.push('/')
                    return
                }

                // 2. Add/Update Player in Firebase
                const playerData = {
                    id: profile.id,
                    username: profile.username,
                    avatar_url: profile.avatar_url,
                    score: 0,
                    is_ready: false,
                    is_host: snapshot.val().host_id === profile.id,
                    joined_at: Date.now()
                }

                await update(playerRef, playerData)

                // 3. Setup Presence (The "Flawless Sync" magic)
                // When user disconnects (closes tab), remove them from the lobby list.
                // This ensures "Ghosts" never exist.
                await onDisconnect(playerRef).remove()

                setRoomData(snapshot.val())
                setLoading(false)

            } catch (e) {
                console.error("Join Error:", e)
                router.push('/')
            }
        }

        joinRoom()

        // Cleanup: If component unmounts (navigating away), remove listener? 
        // Actually onDisconnect handles the socket close.
        // We might want to remove them if they navigate to Home explicitly.
        return () => {
            // Optional cleanup
        }
    }, [code, profile, router])

    if (!profile) return <Onboarding />
    if (loading || !roomData) return <div className="flex-center" style={{ height: '100vh', color: 'white' }}>Connecting to Lobby...</div>

    return (
        <Lobby
            roomCode={code}
            initialSettings={roomData.settings}
            hostId={roomData.host_id}
            isHost={roomData.host_id === profile.id}
        />
    )
}
