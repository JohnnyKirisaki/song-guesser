'use client'

import { useEffect, useRef, useState } from 'react'
import { Clock, Zap, Music, UserPlus } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { soundManager } from '@/lib/sounds'
import confetti from 'canvas-confetti'
import { useFriends } from '@/hooks/useFriends'
import { useUser } from '@/context/UserContext'
import { db } from '@/lib/firebase'
import { ref, get, remove, set, onValue, update } from 'firebase/database'
import { generateRoomCode } from '@/lib/game-utils'
import UserPopover from './UserPopover'
import type { Player } from '@/lib/types'

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
    is_sudden_death?: boolean
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
    const { getFriendStatus, sendFriendRequest } = useFriends()
    const [stats, setStats] = useState<StatItem[]>([])
    const [loading, setLoading] = useState(true)
    const [winner, setWinner] = useState<Player | null>(null)
    const [isDraw, setIsDraw] = useState(false)
    const [drawPlayers, setDrawPlayers] = useState<Player[]>([])
    const [selectedUser, setSelectedUser] = useState<Player | null>(null)
    const [popoverAnchor, setPopoverAnchor] = useState<{ x: number, y: number } | null>(null)
    const [nextRoomCode, setNextRoomCode] = useState<string | null>(null)
    const [creatingRoom, setCreatingRoom] = useState(false)
    const playAgainInFlightRef = useRef(false)
    const [personalRankings, setPersonalRankings] = useState<{ song: RoundHistory, rating: number }[]>([])
    const [mode, setMode] = useState<string>('normal')

    // Listen for Play Again (Next Room)
    useEffect(() => {
        const nextRoomRef = ref(db, `rooms/${roomCode}/next_room_code`)
        const unsub = onValue(nextRoomRef, (snap) => {
            if (snap.exists()) {
                const code = snap.val()
                setNextRoomCode(code)
                // Auto-redirect everyone
                router.push(`/room/${code}`)
            }
        })
        return () => unsub()
    }, [roomCode, router])

    const handleAvatarClick = (player: Player, e: React.MouseEvent) => {
        e.stopPropagation()
        if (player.id === profile?.id) return
        setPopoverAnchor({ x: e.clientX, y: e.clientY })
        setSelectedUser(player)
    }

    const handlePlayAgain = async () => {
        if (!profile) return
        // Ref-based guard prevents double-fire even if React hasn't re-rendered yet
        if (playAgainInFlightRef.current) return
        playAgainInFlightRef.current = true
        try {
            setCreatingRoom(true)
            const newCode = generateRoomCode()

            // Get current settings to clone
            const currentRoomRef = ref(db, `rooms/${roomCode}`)
            const snap = await get(currentRoomRef)
            const currentData = snap.exists() ? snap.val() : {}
            const settings = currentData.settings || { rounds: 10, time: 15, mode: 'normal' }

            const roomData = {
                code: newCode,
                host_id: profile.id,
                status: 'waiting',
                created_at: new Date().toISOString(),
                settings: settings,
                players: {
                    [profile.id]: {
                        id: profile.id,
                        username: profile.username,
                        avatar_url: profile.avatar_url,
                        score: 0,
                        is_ready: false,
                        is_host: true
                    }
                }
            }

            // Create new room
            await set(ref(db, `rooms/${newCode}`), roomData)

            // Notify everyone in current room
            await update(ref(db, `rooms/${roomCode}`), {
                next_room_code: newCode
            })

            // Redirect is handled by the useEffect above

        } catch (e) {
            console.error("Failed to create next room", e)
            setCreatingRoom(false)
            playAgainInFlightRef.current = false
        }
    }

    useEffect(() => {
        soundManager.play('win')
        // Fire confetti burst for the winner
        const duration = 2000
        const end = Date.now() + duration
        const frame = () => {
            confetti({
                particleCount: 3,
                angle: 60,
                spread: 55,
                origin: { x: 0, y: 0.7 },
                colors: ['#FFD700', '#1DB954', '#60a5fa'],
            })
            confetti({
                particleCount: 3,
                angle: 120,
                spread: 55,
                origin: { x: 1, y: 0.7 },
                colors: ['#FFD700', '#1DB954', '#60a5fa'],
            })
            if (Date.now() < end) requestAnimationFrame(frame)
        }
        frame()
    }, [])

    // Update streaks with all co-players
    useEffect(() => {
        if (!profile) return
        const otherPlayers = players.filter(p => p.id !== profile.id)
        if (otherPlayers.length === 0) return

        const today = new Date().toISOString().split('T')[0] // YYYY-MM-DD UTC

        const getYesterday = (dateStr: string): string => {
            const d = new Date(dateStr + 'T00:00:00Z')
            d.setUTCDate(d.getUTCDate() - 1)
            return d.toISOString().split('T')[0]
        }

        const updateStreaks = async () => {
            for (const other of otherPlayers) {
                try {
                    const key = [profile.id, other.id].sort().join('_')
                    const streakRef = ref(db, `streaks/${key}`)
                    const snap = await get(streakRef)
                    const data = snap.val() || { count: 0, last_date: null }

                    if (data.last_date === today) continue // Already counted today

                    const yesterday = getYesterday(today)
                    const newCount = data.last_date === yesterday ? (data.count || 0) + 1 : 1

                    await update(streakRef, { count: newCount, last_date: today })
                } catch {
                    // Silently skip streak errors
                }
            }
        }

        updateStreaks()
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {

        const fetchStats = async () => {
            const fallbackStats: StatItem[] = [
                { label: 'Most Correctly Guessed', value: 'No valid answers', icon: Music, color: '#1ed760' },
                { label: 'Hardest Song', value: 'No valid answers', icon: Zap, color: '#e91429' },
                { label: 'Fastest Correct Guess', value: 'No valid answers', icon: Clock, color: '#3b82f6' }
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
                const currentMode = settings.mode || 'normal'
                setMode(currentMode)
                const isIdentityMode = currentMode === 'guess_who' || currentMode === 'who_sang_that'

                if (!history.length) {
                    setStats(fallbackStats)
                    setLoading(false)
                    return
                }

                if (currentMode === 'chill_rating') {
                    const myRankings = history.map(round => {
                        const myGuess = (round.guesses || []).find(g => g.user_id === profile?.id)
                        const rating = parseInt(myGuess?.guess_title || '0')
                        return { song: round, rating }
                    }).sort((a, b) => b.rating - a.rating)
                    setPersonalRankings(myRankings)
                }

                const formatSong = (song: RoundHistory) => `${song.track_name} - ${song.artist_name}`

                // 1. Most Correctly Guessed song
                const songCounts: Record<string, { count: number, song: RoundHistory }> = {}
                // 2. Hardest song (lowest correct %)
                const songAttempts: Record<string, { total: number, correct: number, song: RoundHistory }> = {}

                let fastestGuess: { guess: RoundGuess, song: RoundHistory } | null = null

                // Identity mode stats: track per-player streaks and accuracy
                const playerStreaks: Record<string, { current: number, best: number, username: string }> = {}
                const playerAccuracy: Record<string, { correct: number, total: number, username: string }> = {}

                for (const round of history) {
                    const guesses = round.guesses || []

                    // MODE-AWARE SCORING
                    const correctGuesses = guesses.filter(g => {
                        if (mode === 'artist_only' || mode === 'who_sang_that') return g.correct_artist || g.correct_title
                        if (mode === 'song_only') return g.correct_title
                        if (mode === 'guess_who') return g.correct_title || g.correct_artist
                        return g.correct_title && g.correct_artist
                    })

                    const key = round.song_id || `${round.track_name}-${round.artist_name}`

                    if (!round.is_sudden_death) {
                        if (!songCounts[key]) songCounts[key] = { count: 0, song: round }
                        songCounts[key].count += correctGuesses.length

                        if (!songAttempts[key]) songAttempts[key] = { total: 0, correct: 0, song: round }
                        songAttempts[key].total += guesses.length
                        songAttempts[key].correct += correctGuesses.length
                    }

                    // Track per-player streaks and accuracy for identity modes
                    if (isIdentityMode) {
                        for (const g of guesses) {
                            const isCorrect = correctGuesses.includes(g)
                            if (!playerAccuracy[g.user_id]) playerAccuracy[g.user_id] = { correct: 0, total: 0, username: g.username }
                            playerAccuracy[g.user_id].total++
                            if (isCorrect) playerAccuracy[g.user_id].correct++

                            if (!playerStreaks[g.user_id]) playerStreaks[g.user_id] = { current: 0, best: 0, username: g.username }
                            if (isCorrect) {
                                playerStreaks[g.user_id].current++
                                if (playerStreaks[g.user_id].current > playerStreaks[g.user_id].best) {
                                    playerStreaks[g.user_id].best = playerStreaks[g.user_id].current
                                }
                            } else {
                                playerStreaks[g.user_id].current = 0
                            }
                        }
                    }

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

                if (isIdentityMode) {
                    // Identity mode awards: Best Streak, Sharpest Eye, Fastest Guess
                    const bestStreakPlayer = Object.values(playerStreaks).sort((a, b) => b.best - a.best)[0]
                    const sharpestPlayer = Object.values(playerAccuracy).filter(p => p.total >= 2).sort((a, b) => (b.correct / b.total) - (a.correct / a.total))[0]

                    if (bestStreakPlayer && bestStreakPlayer.best > 1) {
                        newStats.push({
                            label: 'Best Streak',
                            value: bestStreakPlayer.username,
                            subValue: `${bestStreakPlayer.best} correct in a row`,
                            icon: Zap,
                            color: '#f59e0b'
                        })
                    }

                    if (sharpestPlayer && sharpestPlayer.correct > 0) {
                        newStats.push({
                            label: 'Sharpest Eye',
                            value: sharpestPlayer.username,
                            subValue: `${Math.round((sharpestPlayer.correct / sharpestPlayer.total) * 100)}% accuracy`,
                            icon: Music,
                            color: '#1ed760'
                        })
                    }

                    if (fastestGuess) {
                        newStats.push({
                            label: 'Quickest Instinct',
                            value: fastestGuess.guess.username,
                            subValue: `Answered in ${fastestGuess.guess.time_taken.toFixed(1)}s`,
                            icon: Clock,
                            color: '#3b82f6'
                        })
                    }
                } else {
                    // Standard mode awards
                    if (mostGuessed && mostGuessed.count > 0) {
                        newStats.push({
                            label: 'Most Correctly Guessed',
                            value: formatSong(mostGuessed.song),
                            subValue: `${mostGuessed.count} correct guesses`,
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
                            label: 'Fastest Correct Guess',
                            value: fastestGuess.guess.username,
                            subValue: `${formatSong(fastestGuess.song)} in ${fastestGuess.guess.time_taken.toFixed(1)} s`,
                            icon: Clock,
                            color: '#3b82f6'
                        })
                    }
                }

                const mergedStats = fallbackStats.map(fallback => {
                    const existing = newStats.find(stat => stat.label === fallback.label)
                    return existing || fallback
                })

                setStats(isIdentityMode ? (newStats.length > 0 ? newStats : fallbackStats) : mergedStats)
                setLoading(false)
            } catch (e) {
                console.error('Failed to fetch recap stats', e)
                setStats([
                    { label: 'Most Correctly Guessed', value: 'No valid answers', icon: Music, color: '#1ed760' },
                    { label: 'Hardest Song', value: 'No valid answers', icon: Zap, color: '#e91429' },
                    { label: 'Fastest Correct Guess', value: 'No valid answers', icon: Clock, color: '#3b82f6' }
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

    // Record head-to-head stats
    useEffect(() => {
        if (!winner || !profile || isDraw) return
        const h2hKey = `h2h_recorded_${roomCode}`
        if (typeof window !== 'undefined' && localStorage.getItem(h2hKey) === '1') return

        const recordH2H = async () => {
            const otherPlayers = players.filter(p => p.id !== winner.id)
            for (const loser of otherPlayers) {
                const key = [winner.id, loser.id].sort().join('_')
                const h2hRef = ref(db, `h2h/${key}`)
                const snap = await get(h2hRef)
                const data = snap.val() || {}
                const currentWins = data[winner.id] || 0
                await update(h2hRef, { [winner.id]: currentWins + 1 })
            }
            if (typeof window !== 'undefined') {
                localStorage.setItem(h2hKey, '1')
            }
        }

        recordH2H().catch(() => {})
    }, [winner, profile, isDraw, players, roomCode])

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

    // Find if I am host
    const amIHost = players.find(p => p.id === profile?.id)?.is_host ?? false

    if (loading) return <div className="flex-center" style={{ height: '100vh', color: 'white' }}>Building recap...</div>

    const sortedPlayers = [...players].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return (b.sudden_death_score || 0) - (a.sudden_death_score || 0)
    })
    const winners = sortedPlayers.slice(0, 3)

    const podiumAvatarStyle = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' } as const

    return (
        <div className="container flex-center" style={{ minHeight: '100dvh', flexDirection: 'column', paddingTop: '16px', paddingBottom: '16px', gap: '0' }}>
            <h1 className="text-gradient" style={{ fontSize: 'clamp(1.8rem, 6vw, 3rem)', marginBottom: '4px' }}>Game Over</h1>
            <p style={{ color: '#aaa', marginBottom: 'clamp(10px, 2vh, 20px)' }}>What a game! Here are the standings.</p>

            {/* Podium / Draw / Chill Rankings */}
            {mode === 'chill_rating' ? (
                <div className="animate-in" style={{ width: '100%', maxWidth: '800px', marginBottom: '40px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ background: '#1db954', color: 'black', padding: '6px 16px', borderRadius: '20px', fontWeight: 800, marginBottom: '16px', fontSize: '0.9rem', letterSpacing: '1px' }}>
                        YOUR RANKINGS
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
                        {personalRankings.map((item, idx) => (
                            <div key={idx} className="glass-panel" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '16px', borderLeft: `4px solid ${item.rating >= 8 ? '#1db954' : item.rating >= 5 ? '#ffc107' : '#ff4c60'}` }}>
                                <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '0.9rem', color: '#888' }}>
                                    {idx + 1}
                                </div>
                                <img src={item.song.cover_url || '/placeholder-cover.jpg'} style={{ width: '54px', height: '54px', borderRadius: '8px', objectFit: 'cover', boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.song.track_name}</div>
                                    <div style={{ fontSize: '0.85rem', color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.song.artist_name}</div>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                    <div style={{ fontSize: '0.7rem', fontWeight: 800, color: '#666', marginBottom: '-2px' }}>RATING</div>
                                    <div style={{ fontSize: '1.6rem', fontWeight: 900, color: item.rating >= 8 ? '#1db954' : item.rating >= 5 ? '#ffc107' : '#ff4c60' }}>
                                        {item.rating || '—'}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ) : isDraw && drawPlayers.length > 1 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', marginBottom: '48px' }}>
                    <div style={{ fontWeight: 800, letterSpacing: '2px' }}>DRAW</div>
                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', justifyContent: 'center' }}>
                        {drawPlayers.map(p => (
                            <div key={p.id} className="glass-panel animate-in" style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '200px', borderColor: '#FFD700', boxShadow: '0 0 30px rgba(255, 215, 0, 0.2)' }}>
                                <div
                                    style={{ width: '140px', height: '140px', minWidth: '140px', minHeight: '140px', flex: '0 0 auto', borderRadius: '50%', overflow: 'hidden', border: '3px solid #FFD700', marginBottom: '12px', cursor: 'pointer' }}
                                    onClick={(e) => handleAvatarClick(p, e)}
                                >
                                    <img src={p.avatar_url} style={podiumAvatarStyle} />
                                </div>
                                <h2 style={{ marginBottom: '8px' }}>{p.username}</h2>
                                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#FFD700' }}>{p.score} pts</div>
                            </div>
                        ))}
                    </div>
                </div>
            ) : (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap', justifyContent: 'center', marginBottom: 'clamp(14px, 2.8vh, 28px)' }}>
                    {winners[1] && (
                        <div className="glass-panel podium-card" style={{ padding: '14px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: 'clamp(200px, 34vw, 300px)', justifyContent: 'flex-end', animationDelay: '200ms', minWidth: '126px' }}>
                            <div
                                style={{ width: 'clamp(80px, 14vw, 120px)', height: 'clamp(80px, 14vw, 120px)', minWidth: '0', minHeight: '0', flex: '0 0 auto', borderRadius: '50%', overflow: 'hidden', border: '3px solid silver', marginBottom: '6px', cursor: 'pointer' }}
                                onClick={(e) => handleAvatarClick(winners[1], e)}
                            >
                                <img src={winners[1].avatar_url} style={podiumAvatarStyle} />
                            </div>
                            <h2 style={{ marginBottom: '6px' }}>{winners[1].username}</h2>
                            <div style={{ fontSize: '1.35rem', fontWeight: 700 }}>{winners[1].score} pts</div>
                            <div style={{ marginTop: '8px', color: 'silver' }}>2nd</div>
                        </div>
                    )}

                    {winners[0] && (
                        <div className="glass-panel podium-card" style={{ padding: '14px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: 'clamp(250px, 42vw, 390px)', justifyContent: 'flex-end', borderColor: '#FFD700', boxShadow: '0 0 30px rgba(255, 215, 0, 0.2)', order: -1, zIndex: 10, minWidth: '140px', animationDelay: '100ms' }}>
                            <div
                                style={{ width: 'clamp(100px, 18vw, 150px)', height: 'clamp(100px, 18vw, 150px)', minWidth: '0', minHeight: '0', flex: '0 0 auto', borderRadius: '50%', overflow: 'hidden', border: '4px solid #FFD700', marginBottom: '10px', cursor: 'pointer' }}
                                onClick={(e) => handleAvatarClick(winners[0], e)}
                            >
                                <img src={winners[0].avatar_url} style={podiumAvatarStyle} />
                            </div>
                            <div style={{ background: '#FFD700', color: 'black', padding: '4px 12px', borderRadius: '20px', fontWeight: 'bold', marginBottom: '12px' }}>
                                WINNER
                            </div>
                            <h1 style={{ marginBottom: '6px', fontSize: '1.8rem' }}>{winners[0].username}</h1>
                            <div style={{ fontSize: '1.8rem', fontWeight: 900, color: '#FFD700' }}>{winners[0].score} pts</div>
                        </div>
                    )}

                    {winners[2] && (
                        <div className="glass-panel podium-card" style={{ padding: '14px', display: 'flex', flexDirection: 'column', alignItems: 'center', height: 'clamp(168px, 29vw, 250px)', justifyContent: 'flex-end', animationDelay: '300ms', minWidth: '118px' }}>
                            <div
                                style={{ width: 'clamp(70px, 12vw, 110px)', height: 'clamp(70px, 12vw, 110px)', minWidth: '0', minHeight: '0', flex: '0 0 auto', borderRadius: '50%', overflow: 'hidden', border: '3px solid #CD7F32', marginBottom: '6px', cursor: 'pointer' }}
                                onClick={(e) => handleAvatarClick(winners[2], e)}
                            >
                                <img src={winners[2].avatar_url} style={podiumAvatarStyle} />
                            </div>
                            <h2 style={{ marginBottom: '6px' }}>{winners[2].username}</h2>
                            <div style={{ fontSize: '1.35rem', fontWeight: 700 }}>{winners[2].score} pts</div>
                            <div style={{ marginTop: '8px', color: '#CD7F32' }}>3rd</div>
                        </div>
                    )}
                </div>
            )}

            {/* Stats Grid */}
            {mode !== 'chill_rating' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', width: '100%', maxWidth: '900px', marginBottom: '24px' }}>
                    {stats.map((stat, i) => (
                        <div key={i} className="glass-panel" style={{ padding: '18px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', animationDelay: `${i * 100} ms` }}>
                            <div style={{ width: '42px', height: '42px', borderRadius: '50%', background: `${stat.color} 20`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '12px', color: stat.color }}>
                                <stat.icon size={20} />
                            </div>
                            <h3 style={{ color: '#888', textTransform: 'uppercase', fontSize: '0.76rem', letterSpacing: '1px', marginBottom: '6px' }}>{stat.label}</h3>
                            <div style={{ fontSize: '1.1rem', fontWeight: 'bold', marginBottom: '4px' }}>{stat.value}</div>
                            {stat.subValue && <div style={{ fontSize: '0.9rem', color: '#666' }}>{stat.subValue}</div>}
                        </div>
                    ))}
                </div>
            )}

            {/* Add Friend Prompt */}
            {profile && (() => {
                const nonFriends = players.filter(p => p.id !== profile.id && getFriendStatus(p.id) === 'none')
                if (nonFriends.length === 0) return null
                return (
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '18px' }}>
                        {nonFriends.map(p => (
                            <button
                                key={p.id}
                                className="btn-glass"
                                style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', fontSize: '0.82rem' }}
                                onClick={() => { sendFriendRequest(p.id) }}
                            >
                                <img src={p.avatar_url} style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }} />
                                <UserPlus size={14} />
                                {p.username}
                            </button>
                        ))}
                    </div>
                )
            })()}

            {amIHost ? (
                <div style={{ display: 'flex', gap: '16px', marginTop: '4px' }}>
                    <button onClick={() => router.push('/')} className="btn-glass">
                        Home
                    </button>
                    <button onClick={handlePlayAgain} className="btn-primary" disabled={creatingRoom}>
                        {creatingRoom ? 'Creating...' : 'Play Again'}
                    </button>
                </div>
            ) : (
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginTop: '4px' }}>
                    <button onClick={() => router.push('/')} className="btn-glass">
                        Leave
                    </button>
                    <div style={{ color: '#888', fontStyle: 'italic' }}>
                        {nextRoomCode ? 'Joining next game...' : 'Waiting for host...'}
                    </div>
                </div>
            )}

            {selectedUser && (
                <UserPopover
                    isOpen={!!selectedUser}
                    targetUser={selectedUser}
                    onClose={() => setSelectedUser(null)}
                    currentUserProfileId={profile?.id}
                    anchorPoint={popoverAnchor || undefined}
                />
            )}
        </div>
    )
}
