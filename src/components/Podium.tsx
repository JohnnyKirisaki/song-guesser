'use client'

import { Trophy, Medal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { db } from '@/lib/firebase'
import { ref, get, remove } from 'firebase/database'
import { useUser } from '@/context/UserContext'

export default function Podium({ roomCode }: { roomCode: string }) {
    const [winners, setWinners] = useState<any[]>([])
    const router = useRouter()
    const { profile } = useUser()
    const podiumAvatarStyle = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' } as const

    useEffect(() => {
        const fetchResults = async () => {
            const roomRef = ref(db, `rooms/${roomCode}`)
            const snapshot = await get(roomRef)

            if (snapshot.exists()) {
                const data = snapshot.val()
                const players = Object.values(data.players || {}) as any[]

                // Sort by Score
                const sorted = players.sort((a, b) => b.score - a.score)
                setWinners(sorted.slice(0, 3)) // Top 3
            }
        }
        fetchResults()
    }, [roomCode])

    const handleBackToMenu = async () => {
        // Clean up: Remove player from this room before navigating
        try {
            if (profile) {
                const playerRef = ref(db, `rooms/${roomCode}/players/${profile.id}`)
                await remove(playerRef)

                // Check if room is empty
                const roomRef = ref(db, `rooms/${roomCode}`)
                const snapshot = await get(roomRef)

                if (snapshot.exists()) {
                    const players = snapshot.val().players || {}
                    if (Object.keys(players).length === 0) {
                        await remove(roomRef)
                    }
                } else {
                    // Already deleted
                }
            }
        } catch (e) {
            console.warn('[Podium] Failed to clean up:', e)
        }
        router.push('/')
    }

    if (winners.length === 0) return <div className="flex-center" style={{ height: '100vh', color: 'white' }}>Calculating Results...</div>

    return (
        <div className="flex-center" style={{ flexDirection: 'column', minHeight: '100vh', padding: '40px 20px', gap: '40px', overflowY: 'auto' }}>
            <h1 className="text-gradient" style={{ fontSize: '4rem', fontWeight: 900 }}>Game Over</h1>

            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '20px', flexWrap: 'wrap', justifyContent: 'center' }}>
                {/* 2nd Place */}
                {winners[1] && (
                    <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '250px', justifyContent: 'flex-end' }}>
                        <div style={{ width: '80px', height: '80px', borderRadius: '50%', overflow: 'hidden', border: '3px solid silver', marginBottom: '12px' }}>
                            <img src={winners[1].avatar_url} style={podiumAvatarStyle} />
                        </div>
                        <h2 style={{ marginBottom: '8px' }}>{winners[1].username}</h2>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{winners[1].score} pts</div>
                        <div style={{ marginTop: '12px', color: 'silver' }}><Medal size={32} /></div>
                    </div>
                )}

                {/* 1st Place */}
                {winners[0] && (
                    <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '350px', justifyContent: 'flex-end', borderColor: '#FFD700', boxShadow: '0 0 30px rgba(255, 215, 0, 0.2)' }}>
                        <Trophy size={48} color="#FFD700" style={{ marginBottom: '20px' }} />
                        <div style={{ width: '120px', height: '120px', borderRadius: '50%', overflow: 'hidden', border: '4px solid #FFD700', marginBottom: '16px' }}>
                            <img src={winners[0].avatar_url} style={podiumAvatarStyle} />
                        </div>
                        <h1 style={{ marginBottom: '8px', fontSize: '2rem' }}>{winners[0].username}</h1>
                        <div style={{ fontSize: '2rem', fontWeight: 900, color: '#FFD700' }}>{winners[0].score} pts</div>
                    </div>
                )}

                {/* 3rd Place */}
                {winners[2] && (
                    <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '200px', justifyContent: 'flex-end' }}>
                        <div style={{ width: '70px', height: '70px', borderRadius: '50%', overflow: 'hidden', border: '3px solid #CD7F32', marginBottom: '12px' }}>
                            <img src={winners[2].avatar_url} style={podiumAvatarStyle} />
                        </div>
                        <h2 style={{ marginBottom: '8px' }}>{winners[2].username}</h2>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{winners[2].score} pts</div>
                        <div style={{ marginTop: '12px', color: '#CD7F32' }}><Medal size={32} /></div>
                    </div>
                )}
            </div>

            <button onClick={handleBackToMenu} className="btn-primary" style={{ marginTop: '20px' }}>Back to Menu</button>
        </div>
    )
}
