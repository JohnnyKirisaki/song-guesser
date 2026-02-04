'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Trophy, Clock, Zap, Music } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { soundManager } from '@/lib/sounds'
import Podium from './Podium'
import { useUser } from '@/context/UserContext'

type StatItem = {
    label: string
    value: string
    subValue?: string
    icon: any
    color: string
}

export default function GameRecap({ roomCode, players }: { roomCode: string, players: any[] }) {
    const router = useRouter()
    const { profile, updateProfile } = useUser()
    const [stats, setStats] = useState<StatItem[]>([])
    const [loading, setLoading] = useState(true)
    const [winner, setWinner] = useState<any>(null)

    useEffect(() => {
        soundManager.play('win')
        const fetchStats = async () => {
            // 1. Fetch Guesses
            const { data: guesses } = await supabase
                .from('room_guesses')
                .select(`
                    *,
                    song:room_songs(track_name, artist_name, cover_url)
                `)
                .eq('room_code', roomCode)

            if (!guesses || guesses.length === 0) {
                setLoading(false)
                return
            }

            // 2. Calculate Most Guessed Song
            const songCounts: Record<string, { count: number, song: any }> = {}
            guesses.filter(g => g.is_correct).forEach(g => {
                if (!songCounts[g.song_id]) {
                    songCounts[g.song_id] = { count: 0, song: g.song }
                }
                songCounts[g.song_id].count++
            })

            const sortedSongs = Object.values(songCounts).sort((a, b) => b.count - a.count)
            const mostGuessed = sortedSongs[0]

            // 3. Calculate Hardest Song (Lowest correct %)
            const songAttempts: Record<string, { total: number, correct: number, song: any }> = {}
            guesses.forEach(g => {
                if (!songAttempts[g.song_id]) songAttempts[g.song_id] = { total: 0, correct: 0, song: g.song }
                songAttempts[g.song_id].total++
                if (g.is_correct) songAttempts[g.song_id].correct++
            })

            let hardestSong: any = null
            let lowestRate = 1.1

            Object.values(songAttempts).forEach(item => {
                if (item.total > 0) {
                    const rate = item.correct / item.total
                    if (rate < lowestRate) {
                        lowestRate = rate
                        hardestSong = item
                    }
                }
            })

            // 4. Fastest Guess
            // Filter correct guesses, sort by time_taken (asc)
            // Wait, time_taken is calculated as (Limit - Remaining). So smaller is faster.
            const correctGuesses = guesses.filter(g => g.is_correct).sort((a, b) => a.time_taken - b.time_taken)
            const fastest = correctGuesses[0]
            const fastestPlayer = players.find(p => p.user_id === fastest?.user_id)

            // Compile Stats
            const newStats: StatItem[] = []

            if (mostGuessed) {
                newStats.push({
                    label: 'Crowd Favorite',
                    value: mostGuessed.song.track_name,
                    subValue: `${mostGuessed.count} correct guesses`,
                    icon: Music,
                    color: '#1ed760'
                })
            }

            if (hardestSong) {
                newStats.push({
                    label: 'The Stump-er',
                    value: hardestSong.song.track_name,
                    subValue: `${Math.round((hardestSong.correct / hardestSong.total) * 100)}% accuracy`,
                    icon: Zap,
                    color: '#e91429'
                })
            }

            if (fastest && fastestPlayer) {
                newStats.push({
                    label: 'Speed Demon',
                    value: fastestPlayer.profile.username,
                    subValue: `${fastest.song.track_name} in ${fastest.time_taken} s`,
                    icon: Clock,
                    color: '#3b82f6'
                })
            }

            setStats(newStats)
            setLoading(false)

            // Determine Winner
            const sortedPlayers = [...players].sort((a, b) => b.score - a.score)
            setWinner(sortedPlayers[0])
        }

        fetchStats()
    }, [roomCode, players])

    useEffect(() => {
        if (!winner || !profile) return
        if (winner.user_id !== profile.id) return

        const awardKey = `song_guesser_win_awarded_${roomCode}_${profile.id} `
        if (typeof window !== 'undefined' && localStorage.getItem(awardKey) === '1') return

        const awardWin = async () => {
            await updateProfile({ wins: (profile.wins || 0) + 1 })
            if (typeof window !== 'undefined') {
                localStorage.setItem(awardKey, '1')
            }
        }

        awardWin()
    }, [winner, profile, roomCode, updateProfile])

    // Cleanup: Delete room after game finishes (with delay for viewing recap)
    useEffect(() => {
        const cleanupTimer = setTimeout(async () => {
            // Delete in reverse FK order: guesses → songs → players → room
            await supabase.from('room_guesses').delete().eq('room_code', roomCode)
            await supabase.from('room_songs').delete().eq('room_code', roomCode)
            await supabase.from('room_players').delete().eq('room_code', roomCode)
            await supabase.from('rooms').delete().eq('code', roomCode)

            }, 30000) // 30 seconds delay

        return () => clearTimeout(cleanupTimer)
    }, [roomCode])

    return (
        <div className="container flex-center" style={{ minHeight: '100vh', flexDirection: 'column', paddingTop: '40px', paddingBottom: '40px' }}>
            <h1 className="text-gradient" style={{ fontSize: '3rem', marginBottom: '8px' }}>Game Over</h1>
            <p style={{ color: '#aaa', marginBottom: '40px' }}>What a session! Here are the highlights.</p>

            {/* Winner */}
            {winner && (
                <div className="animate-in" style={{ marginBottom: '48px', textAlign: 'center' }}>
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                        <img
                            src={winner.profile.avatar_url}
                            style={{ width: '120px', height: '120px', borderRadius: '50%', border: '4px solid #ffd700', boxShadow: '0 0 30px rgba(255, 215, 0, 0.4)' }}
                        />
                        <div style={{ position: 'absolute', top: -20, left: '50%', transform: 'translateX(-50%)', background: '#ffd700', color: 'black', padding: '4px 12px', borderRadius: '20px', fontWeight: 'bold' }}>
                            WINNER
                        </div>
                    </div>
                    <h2 style={{ fontSize: '2rem', marginTop: '16px' }}>{winner.profile.username}</h2>
                    <p style={{ fontSize: '1.2rem', color: '#ffd700' }}>{winner.score} pts</p>
                </div>
            )}

            {/* Stats Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px', width: '100%', maxWidth: '900px', marginBottom: '48px' }}>
                {stats.map((stat, i) => (
                    <div key={i} className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', animationDelay: `${i * 100} ms` }}>
                        <div style={{ width: '50px', height: '50px', borderRadius: '50%', background: `${stat.color} 20`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px', color: stat.color }}>
                            <stat.icon size={24} />
                        </div>
                        <h3 style={{ color: '#888', textTransform: 'uppercase', fontSize: '0.8rem', letterSpacing: '1px', marginBottom: '8px' }}>{stat.label}</h3>
                        <div style={{ fontSize: '1.2rem', fontWeight: 'bold', marginBottom: '4px' }}>{stat.value}</div>
                        {stat.subValue && <div style={{ fontSize: '0.9rem', color: '#666' }}>{stat.subValue}</div>}
                    </div>
                ))}
            </div>

            <button onClick={() => router.push('/')} className="btn-primary">
                Back to Lobby
            </button>
        </div>
    )
}
