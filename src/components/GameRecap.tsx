'use client'

import { useEffect, useState } from 'react'
import { Clock, Zap, Music } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { soundManager } from '@/lib/sounds'
import { useUser } from '@/context/UserContext'
import { db } from '@/lib/firebase'
import { ref, get, remove } from 'firebase/database'

type Player = {
    id: string
    username: string
    avatar_url: string
    score: number
    sudden_death_score?: number
}

type RoundGuess = {
    user_id: string
    username: string
    avatar_url: string
    guess_title: string
    guess_artist: string
    correct_title: boolean
    correct_artist: boolean
    is_correct: boolean
    points: number
    time_taken: number
}

type RoundHistory = {
    song_id: string
    track_name: string
    artist_name: string
    cover_url?: string
    guesses: RoundGuess[]
}

type StatItem = {
    label: string
    value: string
    subValue?: string
    icon: any
    color: string
}

export default function GameRecap({ roomCode, players }: { roomCode: string, players: Player[] }) {
    const router = useRouter()
    const { profile, updateProfile } = useUser()
    const [stats, setStats] = useState<StatItem[]>([])
    const [loading, setLoading] = useState(true)
    const [winner, setWinner] = useState<Player | null>(null)
    const [isDraw, setIsDraw] = useState(false)
    const [drawPlayers, setDrawPlayers] = useState<Player[]>([])

    useEffect(() => {
        soundManager.play('win')
    }, [])

    useEffect(() => {
        const fetchStats = async () => {
            const fallbackStats: StatItem[] = [
                { label: 'Most Guessed', value: 'No valid answers', icon: Music, color: '#1ed760' },
                { label: 'Hardest Song', value: 'No valid answers', icon: Zap, color: '#e91429' },
                { label: 'Fastest Guess', value: 'No valid answers', icon: Clock, color: '#3b82f6' }
            ]

            try {
                const snapshot = await get(ref(db, `rooms/${roomCode}`))
                if (!snapshot.exists()) {
                    setStats(fallbackStats)
                    setLoading(false)
                    return
                }

                const data = snapshot.val()
                const history = Object.values(data.round_history || {}) as RoundHistory[]
                const settings = data.settings || {}
                const mode = settings.mode || 'normal'

                if (!history.length) {
                    setStats(fallbackStats)
                    setLoading(false)
                    return
                }

                const formatSong = (song: RoundHistory) => `${song.track_name} - ${song.artist_name}`

                // 1. Most guessed song
                const songCounts: Record<string, { count: number, song: RoundHistory }> = {}
                // 2. Hardest song (lowest correct %)
                const songAttempts: Record<string, { total: number, correct: number, song: RoundHistory }> = {}

                let fastestGuess: { guess: RoundGuess, song: RoundHistory } | null = null

                for (const round of history) {
                    const guesses = round.guesses || []

                    // MODE-AWARE SCORING
                    const correctGuesses = guesses.filter(g => {
                        if (mode === 'artist_only') return g.correct_artist
                        if (mode === 'song_only') return g.correct_title
                        // Normal / Hardcore
                        return g.correct_title && g.correct_artist
                    })

                    const key = round.song_id || `${round.track_name}-${round.artist_name}`

                    if (!songCounts[key]) songCounts[key] = { count: 0, song: round }
                    songCounts[key].count += correctGuesses.length

                    if (!songAttempts[key]) songAttempts[key] = { total: 0, correct: 0, song: round }
                    songAttempts[key].total += guesses.length
                    songAttempts[key].correct += correctGuesses.length

                    for (const g of correctGuesses) {
                        if (!fastestGuess || g.time_taken < (fastestGuess as any).guess.time_taken) {
                            fastestGuess = { guess: g, song: round }
                        }
                    }
                }

                const mostGuessed = Object.values(songCounts).sort((a, b) => b.count - a.count)[0]

                let hardestSong: { total: number, correct: number, song: RoundHistory } | null = null
                for (const item of Object.values(songAttempts)) {
                    if (item.total === 0) continue
                    const rate = item.correct / item.total
                    if (!hardestSong) {
                        hardestSong = item
                        continue
                    }
                    const currentRate = (hardestSong as any).correct / (hardestSong as any).total
                    if (rate < currentRate) hardestSong = item
                }

                const newStats: StatItem[] = []

                if (mostGuessed && mostGuessed.count > 0) {
                    newStats.push({
                        label: 'Most Guessed',
                        value: formatSong(mostGuessed.song),
                        subValue: `${mostGuessed.count} correct guesses`, // Changed from 'perfect' to 'correct' to be generic
                        icon: Music,
                        color: '#1ed760'
                    })
                }

                if (hardestSong) {
                    newStats.push({
                        label: 'Hardest Song',
                        value: formatSong(hardestSong.song),
                        subValue: `${Math.round((hardestSong.correct / hardestSong.total) * 100)}% accuracy`,
                        icon: Zap,
                        color: '#e91429'
                    })
                }

                if (fastestGuess) {
                    newStats.push({
                        label: 'Fastest Guess',
                        value: fastestGuess.guess.username,
                        subValue: `${formatSong(fastestGuess.song)} in ${fastestGuess.guess.time_taken.toFixed(1)} s`,
                        icon: Clock,
                        color: '#3b82f6'
                    })
                }

                const mergedStats = fallbackStats.map(fallback => {
                    const existing = newStats.find(stat => stat.label === fallback.label)
                    return existing || fallback
                })

                setStats(mergedStats)
                setLoading(false)
            } catch (e) {
                console.error('Failed to fetch recap stats', e)
                setStats([
                    { label: 'Most Guessed', value: 'No valid answers', icon: Music, color: '#1ed760' },
                    { label: 'Hardest Song', value: 'No valid answers', icon: Zap, color: '#e91429' },
                    { label: 'Fastest Guess', value: 'No valid answers', icon: Clock, color: '#3b82f6' }
                ])
                setLoading(false)
            }
        }

        fetchStats()
    }, [roomCode])

    useEffect(() => {
        const fetchDraw = async () => {
            try {
                const gsSnap = await get(ref(db, `rooms/${roomCode}/game_state`))
                if (!gsSnap.exists()) return
                const gs = gsSnap.val()
                const draw = !!gs?.draw
                const ids = Array.isArray(gs?.draw_player_ids) ? gs.draw_player_ids : []
                setIsDraw(draw && ids.length > 1)
                if (ids.length > 1) {
                    setDrawPlayers(players.filter(p => ids.includes(p.id)))
                }
            } catch (e) {
                console.warn('Failed to read draw state', e)
            }
        }

        fetchDraw()
    }, [roomCode, players])

    useEffect(() => {
        if (!players || players.length === 0) return
        const sortedPlayers = [...players].sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score
            return (b.sudden_death_score || 0) - (a.sudden_death_score || 0)
        })
        setWinner(sortedPlayers[0] || null)
    }, [players])

    useEffect(() => {
        if (!winner || !profile) return
        if (isDraw) return
        if (winner.id !== profile.id) return

        const awardKey = `song_guesser_win_awarded_${roomCode}_${profile.id}`
        if (typeof window !== 'undefined' && localStorage.getItem(awardKey) === '1') return

        const awardWin = async () => {
            await updateProfile({ wins: (profile.wins || 0) + 1 })
            if (typeof window !== 'undefined') {
                localStorage.setItem(awardKey, '1')
            }
        }

        awardWin()
    }, [winner, profile, roomCode, updateProfile])

    // Cleanup: Delete room after game finishes (delay so players can view recap)
    useEffect(() => {
        const cleanupTimer = setTimeout(async () => {
            try {
                await remove(ref(db, `rooms/${roomCode}`))
            } catch (e) {
                console.warn('[GameRecap] Failed to delete room:', e)
            }
        }, 30000) // 30 seconds delay

        return () => clearTimeout(cleanupTimer)
    }, [roomCode])

    if (loading) return <div className="flex-center" style={{ height: '100vh', color: 'white' }}>Building recap...</div>

    const sortedPlayers = [...players].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return (b.sudden_death_score || 0) - (a.sudden_death_score || 0)
    })
    const winners = sortedPlayers.slice(0, 3)

    const podiumAvatarStyle = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' } as const

    return (
        <div className="container flex-center" style={{ minHeight: '100vh', flexDirection: 'column', paddingTop: '40px', paddingBottom: '40px' }}>
            <h1 className="text-gradient" style={{ fontSize: '3rem', marginBottom: '8px' }}>Game Over</h1>
            <p style={{ color: '#aaa', marginBottom: '40px' }}>What a game! Here are the standings.</p>

            {/* Podium / Draw */}
            {isDraw && drawPlayers.length > 1 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', marginBottom: '48px' }}>
                    <div style={{ fontWeight: 800, letterSpacing: '2px' }}>DRAW</div>
                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', justifyContent: 'center' }}>
                        {drawPlayers.map(p => (
                            <div key={p.id} className="glass-panel animate-in" style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '200px', borderColor: '#FFD700', boxShadow: '0 0 30px rgba(255, 215, 0, 0.2)' }}>
                                <div style={{ width: '120px', height: '120px', minWidth: '120px', minHeight: '120px', flex: '0 0 auto', borderRadius: '50%', overflow: 'hidden', border: '3px solid #FFD700', marginBottom: '12px' }}>
                                    <img src={p.avatar_url} style={podiumAvatarStyle} />
                                </div>
                                <h2 style={{ marginBottom: '8px' }}>{p.username}</h2>
                                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#FFD700' }}>{p.score} pts</div>
                            </div>
                        ))}
                    </div>
                </div>
            ) : (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '20px', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '48px' }}>
                    {winners[1] && (
                        <div className="glass-panel animate-in" style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '340px', justifyContent: 'flex-end', animationDelay: '200ms' }}>
                            <div style={{ width: '110px', height: '110px', minWidth: '110px', minHeight: '110px', flex: '0 0 auto', borderRadius: '50%', overflow: 'hidden', border: '3px solid silver', marginBottom: '12px' }}>
                                <img src={winners[1].avatar_url} style={podiumAvatarStyle} />
                            </div>
                            <h2 style={{ marginBottom: '8px' }}>{winners[1].username}</h2>
                            <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{winners[1].score} pts</div>
                            <div style={{ marginTop: '12px', color: 'silver' }}>2nd</div>
                        </div>
                    )}

                    {winners[0] && (
                        <div className="glass-panel animate-in" style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '460px', justifyContent: 'flex-end', borderColor: '#FFD700', boxShadow: '0 0 30px rgba(255, 215, 0, 0.2)', order: -1, zIndex: 10 }}>
                            <div style={{ width: '160px', height: '160px', minWidth: '160px', minHeight: '160px', flex: '0 0 auto', borderRadius: '50%', overflow: 'hidden', border: '4px solid #FFD700', marginBottom: '16px' }}>
                                <img src={winners[0].avatar_url} style={podiumAvatarStyle} />
                            </div>
                            <div style={{ background: '#FFD700', color: 'black', padding: '4px 12px', borderRadius: '20px', fontWeight: 'bold', marginBottom: '16px' }}>
                                WINNER
                            </div>
                            <h1 style={{ marginBottom: '8px', fontSize: '2rem' }}>{winners[0].username}</h1>
                            <div style={{ fontSize: '2rem', fontWeight: 900, color: '#FFD700' }}>{winners[0].score} pts</div>
                        </div>
                    )}

                    {winners[2] && (
                        <div className="glass-panel animate-in" style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '280px', justifyContent: 'flex-end', animationDelay: '400ms' }}>
                            <div style={{ width: '100px', height: '100px', minWidth: '100px', minHeight: '100px', flex: '0 0 auto', borderRadius: '50%', overflow: 'hidden', border: '3px solid #CD7F32', marginBottom: '12px' }}>
                                <img src={winners[2].avatar_url} style={podiumAvatarStyle} />
                            </div>
                            <h2 style={{ marginBottom: '8px' }}>{winners[2].username}</h2>
                            <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{winners[2].score} pts</div>
                            <div style={{ marginTop: '12px', color: '#CD7F32' }}>3rd</div>
                        </div>
                    )}
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
