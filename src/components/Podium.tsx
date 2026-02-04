'use client'

import { Trophy, Medal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useUser } from '@/context/UserContext'

export default function Podium({ roomCode }: { roomCode: string }) {
    const [winners, setWinners] = useState<any[]>([])
    const [stats, setStats] = useState<any>(null)
    const router = useRouter()
    const { profile } = useUser()

    useEffect(() => {
        const fetchResults = async () => {
            // Fetch Winners
            const { data: winnersData } = await supabase
                .from('room_players')
                .select('*, profile:profiles(username, avatar_url)')
                .eq('room_code', roomCode)
                .order('score', { ascending: false })
                .limit(3)

            if (winnersData) setWinners(winnersData)

            // Fetch Guesses for Stats
            const { data: guesses } = await supabase
                .from('room_guesses')
                .select('*, profile:profiles(username), song:room_songs(track_name, artist_name, cover_url)')
                .eq('room_code', roomCode)

            if (guesses && guesses.length > 0) {
                // 1. Fastest Guess
                const correctGuesses = guesses.filter(g => g.is_correct)
                const fastest = correctGuesses.sort((a, b) => a.time_taken - b.time_taken)[0]

                // 2. Hardest Song (Lowest % Correct) & Most Known (Highest Count Correct)
                const songStats: Record<string, { correct: number, total: number, song: any }> = {}

                guesses.forEach(g => {
                    if (!g.song_id || !g.song) return
                    if (!songStats[g.song_id]) songStats[g.song_id] = { correct: 0, total: 0, song: g.song }

                    songStats[g.song_id].total++
                    if (g.is_correct) songStats[g.song_id].correct++
                })

                let hardest = null
                let easiest = null
                let lowestAcc = 101
                let highestAcc = -1

                Object.values(songStats).forEach(s => {
                    const acc = (s.correct / s.total) * 100
                    if (acc < lowestAcc) {
                        lowestAcc = acc
                        hardest = s
                    }
                    if (acc > highestAcc) {
                        highestAcc = acc
                        easiest = s
                    }
                })

                setStats({
                    fastest: fastest ? {
                        user: fastest.profile?.username,
                        time: fastest.time_taken,
                        song: fastest.song?.track_name
                    } : null,
                    hardest: hardest ? {
                        song: (hardest as any).song.track_name,
                        artist: (hardest as any).song.artist_name,
                        cover: (hardest as any).song.cover_url,
                        acc: Math.round(lowestAcc)
                    } : null,
                    easiest: easiest ? {
                        song: (easiest as any).song.track_name,
                        acc: Math.round(highestAcc)
                    } : null
                })
            }
        }
        fetchResults()
    }, [roomCode])

    const handleBackToMenu = async () => {
        // Clean up: Remove player from this room before navigating
        try {
            if (profile) {
                await supabase.from('room_players').delete().eq('room_code', roomCode).eq('user_id', profile.id)

                // Check if room is empty
                const { count } = await supabase.from('room_players').select('*', { count: 'exact', head: true }).eq('room_code', roomCode)
                if (count === 0) {
                    await supabase.from('rooms').delete().eq('code', roomCode)
                }
            }
        } catch (e) {
            console.warn('[Podium] Failed to clean up room_players:', e)
        }
        // Always navigate, even if cleanup fails
        router.push('/')
    }

    if (winners.length === 0) return <div className="flex-center" style={{ height: '100vh' }}>Calculating Results...</div>

    return (
        <div className="flex-center" style={{ flexDirection: 'column', minHeight: '100vh', padding: '40px 20px', gap: '40px', overflowY: 'auto' }}>
            <h1 className="text-gradient" style={{ fontSize: '4rem', fontWeight: 900 }}>Game Over</h1>

            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '20px', flexWrap: 'wrap', justifyContent: 'center' }}>
                {/* 2nd Place */}
                {winners[1] && (
                    <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '250px', justifyContent: 'flex-end' }}>
                        <div style={{ width: '80px', height: '80px', borderRadius: '50%', overflow: 'hidden', border: '3px solid silver', marginBottom: '12px' }}>
                            <img src={winners[1].profile.avatar_url} style={{ width: '100%', height: '100%' }} />
                        </div>
                        <h2 style={{ marginBottom: '8px' }}>{winners[1].profile.username}</h2>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{winners[1].score} pts</div>
                        <div style={{ marginTop: '12px', color: 'silver' }}><Medal size={32} /></div>
                    </div>
                )}

                {/* 1st Place */}
                {winners[0] && (
                    <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '350px', justifyContent: 'flex-end', borderColor: '#FFD700', boxShadow: '0 0 30px rgba(255, 215, 0, 0.2)' }}>
                        <Trophy size={48} color="#FFD700" style={{ marginBottom: '20px' }} />
                        <div style={{ width: '120px', height: '120px', borderRadius: '50%', overflow: 'hidden', border: '4px solid #FFD700', marginBottom: '16px' }}>
                            <img src={winners[0].profile.avatar_url} style={{ width: '100%', height: '100%' }} />
                        </div>
                        <h1 style={{ marginBottom: '8px', fontSize: '2rem' }}>{winners[0].profile.username}</h1>
                        <div style={{ fontSize: '2rem', fontWeight: 900, color: '#FFD700' }}>{winners[0].score} pts</div>
                    </div>
                )}

                {/* 3rd Place */}
                {winners[2] && (
                    <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '200px', justifyContent: 'flex-end' }}>
                        <div style={{ width: '70px', height: '70px', borderRadius: '50%', overflow: 'hidden', border: '3px solid #CD7F32', marginBottom: '12px' }}>
                            <img src={winners[2].profile.avatar_url} style={{ width: '100%', height: '100%' }} />
                        </div>
                        <h2 style={{ marginBottom: '8px' }}>{winners[2].profile.username}</h2>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{winners[2].score} pts</div>
                        <div style={{ marginTop: '12px', color: '#CD7F32' }}><Medal size={32} /></div>
                    </div>
                )}
            </div>

            {/* Stats Section */}
            {stats && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', width: '100%', maxWidth: '800px' }}>

                    {stats.fastest && (
                        <div className="glass-panel" style={{ padding: '20px' }}>
                            <h3 style={{ color: '#aaa', fontSize: '0.9rem', marginBottom: '8px' }}>⚡ Fastest Finger</h3>
                            <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{stats.fastest.user}</div>
                            <div style={{ fontSize: '0.9rem' }}>{stats.fastest.time}s on "{stats.fastest.song}"</div>
                        </div>
                    )}

                    {stats.hardest && (
                        <div className="glass-panel" style={{ padding: '20px' }}>
                            <h3 style={{ color: '#aaa', fontSize: '0.9rem', marginBottom: '8px' }}>🧠 Hardest Track</h3>
                            <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{stats.hardest.song}</div>
                            <div style={{ fontSize: '0.9rem' }}>Only {stats.hardest.acc}% got it right</div>
                        </div>
                    )}

                    {stats.easiest && (
                        <div className="glass-panel" style={{ padding: '20px' }}>
                            <h3 style={{ color: '#aaa', fontSize: '0.9rem', marginBottom: '8px' }}>🔥 Most Known</h3>
                            <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{stats.easiest.song}</div>
                            <div style={{ fontSize: '0.9rem' }}>{stats.easiest.acc}% got it right</div>
                        </div>
                    )}
                </div>
            )}

            <button onClick={handleBackToMenu} className="btn-primary" style={{ marginTop: '20px' }}>Back to Menu</button>
        </div>
    )
}

