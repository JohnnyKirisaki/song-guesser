'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { db } from '@/lib/firebase'
import { ref, get, set, onDisconnect, update, child, serverTimestamp } from 'firebase/database'
import { useUser } from '@/context/UserContext'
import Lobby from '@/components/Lobby'
import Onboarding from '@/components/Onboarding'

export default function RoomLobby() {
    const params = useParams()
    const searchParams = useSearchParams()
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

            // Spectator mode is a URL flag (?spectate=1) so the "Watch" button
            // on MainMenu can route straight to /room/XYZ?spectate=1. Also
            // honor existing spectator status on rejoin so a refresh doesn't
            // silently promote a spectator into a player.
            const spectateParam = searchParams?.get('spectate') === '1'

            try {
                // 1. Check if room exists
                const snapshot = await get(roomRef)
                if (!snapshot.exists()) {
                    alert('Room not found')
                    router.push('/')
                    return
                }

                const roomVal = snapshot.val()
                const existingPlayer = roomVal?.players?.[profile.id]
                const isSpectator = spectateParam || existingPlayer?.is_spectator === true

                // 2. If game is already in progress, rejoin directly
                if (roomVal.status === 'playing' && roomVal.game_state) {
                    // Reconstruct score from round_history if the player slot was dropped
                    let restoredScore = existingPlayer?.score ?? 0
                    if (!existingPlayer) {
                        const historySnap = await get(ref(db, `rooms/${code}/round_history`))
                        if (historySnap.exists()) {
                            const history = Object.values(historySnap.val()) as any[]
                            restoredScore = history.reduce((sum, round) => {
                                const guess = (round.guesses || []).find((g: any) => g.user_id === profile.id)
                                return sum + (guess?.points ?? 0)
                            }, 0)
                        }
                    }

                    await update(playerRef, {
                        id: profile.id,
                        username: profile.username,
                        avatar_url: profile.avatar_url,
                        score: isSpectator ? 0 : restoredScore,
                        is_host: roomVal.host_id === profile.id,
                        is_ready: true,
                        is_spectator: isSpectator,
                        has_submitted: existingPlayer?.has_submitted ?? false,
                        last_guess: existingPlayer?.last_guess ?? null,
                        joined_at: existingPlayer?.joined_at ?? Date.now(),
                        // Clear any prior disconnect mark; we're back.
                        disconnected_at: null,
                        last_seen: serverTimestamp() as any
                    })
                    // 60s grace: on network disconnect mid-game, stamp
                    // `disconnected_at` instead of removing the slot so the
                    // reveal route + other clients can distinguish "fled" from
                    // "blip." A periodic sweeper (in game page) cleans up
                    // slots that stay disconnected past the window.
                    await onDisconnect(playerRef).update({
                        disconnected_at: serverTimestamp() as any
                    })
                    router.push(`/game/${code}`)
                    return
                }

                // 3. Normal lobby join — preserve score if already present (e.g. page refresh)
                const playerData = {
                    id: profile.id,
                    username: profile.username,
                    avatar_url: profile.avatar_url,
                    score: existingPlayer?.score ?? 0,
                    is_ready: existingPlayer?.is_ready ?? false,
                    is_host: roomVal.host_id === profile.id,
                    is_spectator: isSpectator,
                    joined_at: existingPlayer?.joined_at ?? Date.now(),
                    disconnected_at: null,
                    last_seen: serverTimestamp() as any
                }

                await update(playerRef, playerData)

                // 4. Setup Presence — in lobby, remove cleanly on disconnect
                // (no grace period needed, the game hasn't started).
                await onDisconnect(playerRef).remove()

                setRoomData(roomVal)
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
    }, [code, profile, router, searchParams])

    if (!profile) return (
        <div style={{ height: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Onboarding />
        </div>
    )
    if (loading || !roomData) return <div className="flex-center" style={{ height: '100dvh', color: 'white' }}>Connecting to Lobby...</div>

    return (
        <Lobby
            roomCode={code}
            initialSettings={roomData.settings}
            hostId={roomData.host_id}
            isHost={roomData.host_id === profile.id}
        />
    )
}
