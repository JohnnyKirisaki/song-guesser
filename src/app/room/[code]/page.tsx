'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useUser } from '@/context/UserContext'
import Lobby from '@/components/Lobby'
import Onboarding from '@/components/Onboarding'

export default function RoomLobby() {
    const params = useParams()
    const code = params.code as string
    const { user, profile } = useUser()
    const router = useRouter()
    const [loading, setLoading] = useState(true)
    const [roomData, setRoomData] = useState<any>(null)

    // Basic check if room exists & Auto-join
    useEffect(() => {
        const checkAndJoinRoom = async () => {
            // 1. Check if room exists
            const { data: room, error: roomError } = await supabase
                .from('rooms')
                .select('*')
                .eq('code', code)
                .single()

            if (roomError || !room) {
                alert('Room not found')
                router.push('/')
                return
            }

            if (!profile) return
            // 2. Auto-join if not already in room
            const { data: player } = await supabase
                .from('room_players')
                .select('*')
                .eq('room_code', code)
                .eq('user_id', profile.id)
                .single()

            if (!player) {
                console.log('[RoomLobby] User not in room. Auto-joining...')
                const { error: joinError } = await supabase
                    .from('room_players')
                    .insert({
                        room_code: code,
                        user_id: profile.id
                    })

                if (joinError) {
                    console.error('[RoomLobby] Join error:', joinError)
                    // If it's a conflict error, they actually are in the room (race condition)
                    if (joinError.code !== '23505') {
                        alert('Failed to join room')
                        router.push('/')
                        return
                    }
                }
            }

            setRoomData(room)
            setLoading(false)
        }

        if (code && profile) checkAndJoinRoom()
    }, [code, router, profile])

    // Wait for user/profile check AFTER hooks
    if (!profile) {
        return <Onboarding />
    }

    if (loading || !roomData || !profile) return <div className="flex-center" style={{ height: '100vh' }}>Loading Room...</div>

    return (
        <Lobby
            roomCode={code}
            initialSettings={roomData.settings}
            hostId={roomData.host_id}
            isHost={roomData.host_id === profile.id}
        />
    )
}
