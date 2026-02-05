'use client'

import { useEffect, useState, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { db } from '@/lib/firebase'
import { ref, onValue, update, get, serverTimestamp, onDisconnect } from 'firebase/database'
import { useUser } from '@/context/UserContext'
import { GameState, SongItem } from '@/lib/game-logic'
import { useVolume } from '@/context/VolumeContext'

import { Music, Check } from 'lucide-react'
import ProgressBar from '@/components/ProgressBar'
import { calculateScore } from '@/lib/scoring'
import { soundManager } from '@/lib/sounds'
import EmoteBar from '@/components/EmoteBar'
import Onboarding from '@/components/Onboarding'
import GameRecap from '@/components/GameRecap'
import { initiateSuddenDeath, fetchMoreSuddenDeathSongs, endSuddenDeath } from '@/lib/sudden-death'

type Player = {
    id: string
    username: string
    avatar_url: string
    score: number
    has_submitted: boolean
    submitted_at?: number | string | null
    last_guess?: { artist: string, title: string }
    last_round_points?: number
    last_round_correct_title?: boolean
    last_round_correct_artist?: boolean
    last_round_time_taken?: number
    is_host: boolean
    sudden_death_score?: number
}

export default function GamePage() {
    const params = useParams()
    const code = params.code as string
    const { profile } = useUser()
    const router = useRouter()

    const [gameState, setGameState] = useState<GameState | null>(null)
    const [roomSettings, setRoomSettings] = useState<any>(null)
    const [status, setStatus] = useState('playing')
    const [timeLeft, setTimeLeft] = useState(-1)
    const [timeSynced, setTimeSynced] = useState(false)
    const [isPlaying, setIsPlaying] = useState(false)
    const [guess, setGuess] = useState({ artist: '', title: '' })
    const [hasSubmitted, setHasSubmitted] = useState(false) // Local UI state
    const [totalScore, setTotalScore] = useState(0)
    const [players, setPlayers] = useState<Player[]>([])
    const [lyricsSnippet, setLyricsSnippet] = useState<string | null>(null)
    const [lyricsLoading, setLyricsLoading] = useState(false)
    const [serverTimeOffset, setServerTimeOffset] = useState(0)
    const { volume } = useVolume()

    // Refs
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const audioRetryRef = useRef<Record<string, boolean>>({})
    const lastRevealSoundRoundRef = useRef<number | null>(null)
    const playersRef = useRef<Player[]>([]) // Authoritative ref to avoid stale closures
    const latestGuessRef = useRef({ artist: '', title: '' }) // Latest text input
    const hasSubmittedRef = useRef(false) // Ref for sync logic to avoid stale closure
    const titleInputRef = useRef<HTMLInputElement | null>(null)
    const artistInputRef = useRef<HTMLInputElement | null>(null)
    const lyricsCacheRef = useRef<Record<string, string | null>>({})
    const processingRoundRef = useRef<number | null>(null) // Prevention for double-execution

    // Sync Clock Skew
    useEffect(() => {
        const offsetRef = ref(db, '.info/serverTimeOffset')
        return onValue(offsetRef, (snap) => {
            setServerTimeOffset(snap.val() || 0)
            setTimeSynced(true)
        })
    }, [])

    // Sync volume to audio element
    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.volume = volume
        }
        // Also update SFX volume if possible
        soundManager.setVolume(volume)
    }, [volume])

    // Ensure volume is applied when audio element mounts/ref updates
    const onAudioRefChange = (node: HTMLAudioElement | null) => {
        audioRef.current = node
        if (node) {
            node.volume = volume // Apply immediate volume
        }
    }

    // Wait for profile
    if (!profile) return <Onboarding />

    // Derived
    const hostId = players.find(p => p.is_host)?.id
    const isHost = profile.id === hostId
    const currentSong = gameState?.playlist[gameState?.current_round_index || 0]
    const mode = roomSettings?.mode || 'normal'
    const isLyricsOnly = mode === 'lyrics_only'
    const isArtistOnly = mode === 'artist_only'
    const isSongOnly = mode === 'song_only'
    const showTitleInput = mode !== 'artist_only'
    const showArtistInput = mode !== 'song_only'
    const duelingIds = gameState?.dueling_player_ids || []
    const isSuddenDeath = !!gameState?.is_sudden_death
    const isDuelingPlayer = !isSuddenDeath || duelingIds.length === 0 || duelingIds.includes(profile.id)
    const canGuess = gameState?.phase === 'playing' && isDuelingPlayer
    const songPicker = currentSong ? players.find(p => p.id === currentSong.picked_by_user_id) : null
    const isMySong = songPicker?.id === profile.id

    // --------------------------------------------------------------------------------
    // 1. SYNC (The Heartbeat)
    // --------------------------------------------------------------------------------
    useEffect(() => {
        const roomRef = ref(db, `rooms/${code}`)

        const unsubscribe = onValue(roomRef, (snapshot) => {
            const data = snapshot.val()
            if (!data) {
                router.push('/')
                return
            }

            setRoomSettings(data.settings)

            // Sync Players
            if (data.players) {
                const pList = Object.values(data.players) as Player[]
                setPlayers(pList)

                // Sync personal score & submission status
                const me = pList.find(p => p.id === profile.id)
                if (me) {
                    setTotalScore(me.score)

                    // Initial Sync / Reconnect Protection (Use ref to avoid stale closure)
                    if (me.has_submitted && !hasSubmittedRef.current) {
                        setHasSubmitted(true)
                    }
                }
            }

            // Sync Game State
            if (data.game_state) {
                const serverState = data.game_state
                setGameState(serverState)

                // Timer Sync
                if (serverState.phase === 'playing' && serverState.round_start_time) {
                    const startRaw = serverState.round_start_time
                    const startMs = typeof startRaw === 'number'
                        ? startRaw
                        : new Date(startRaw).getTime()

                    const totalTime = data.settings.time || 15

                    if (!Number.isNaN(startMs)) {
                        const elapsed = (Date.now() - startMs) / 1000
                        const remaining = Math.max(0, totalTime - elapsed) // FLOAT for smooth bar

                        const forceRaw = serverState.force_reveal_at
                        if (forceRaw) {
                            const forceMs = typeof forceRaw === 'number'
                                ? forceRaw
                                : new Date(forceRaw).getTime()
                            const forceRemaining = Math.max(0, (forceMs - Date.now()) / 1000)
                            setTimeLeft(Math.min(remaining, forceRemaining))
                        } else {
                            setTimeLeft(remaining)
                        }
                    } else {
                        setTimeLeft(totalTime)
                    }
                }

                if (serverState.phase === 'reveal') {
                    setTimeLeft(0)
                }
            }

            setStatus(data.status)
        })

        return () => unsubscribe()
    }, [code, router, profile.id])

    // Track hasSubmitted in ref to avoid stale closure in listener
    useEffect(() => {
        hasSubmittedRef.current = hasSubmitted
    }, [hasSubmitted])

    // Reconnect protection: keep player slot during game
    useEffect(() => {
        if (!profile) return
        const playerRef = ref(db, `rooms/${code}/players/${profile.id}`)
        onDisconnect(playerRef).cancel()
    }, [code, profile])

    // --------------------------------------------------------------------------------
    // 2. ROUND TRANSITIONS (Resets)
    // --------------------------------------------------------------------------------
    useEffect(() => {
        if (gameState?.current_round_index !== undefined) {
            setHasSubmitted(false)
            setGuess({ artist: '', title: '' })
            setLyricsSnippet(null)
        }
    }, [gameState?.current_round_index])

    const fetchLyricsForSong = async (song: SongItem, updateState: boolean) => {
        if (!song) return

        const cached = lyricsCacheRef.current[song.id]
        if (cached !== undefined) {
            if (updateState) {
                setLyricsSnippet(cached)
                setLyricsLoading(false)
            }
            return
        }

        if (updateState) setLyricsLoading(true)

        try {
            // Check Firebase Cache (populated by Lobby prefetch)
            const cacheRef = ref(db, `rooms/${code}/lyrics_cache/${song.id}`)
            const snap = await get(cacheRef)
            if (snap.exists()) {
                const lyrics = snap.val() as string
                lyricsCacheRef.current[song.id] = lyrics
                if (updateState) {
                    setLyricsSnippet(lyrics)
                    setLyricsLoading(false)
                }
                return
            }

            // Fallback: Fetch API
            const res = await fetch(`/api/lyrics?artist=${encodeURIComponent(song.artist_name)}&title=${encodeURIComponent(song.track_name)}`)
            const data = await res.json()
            const lyrics = data.lyrics || null
            lyricsCacheRef.current[song.id] = lyrics
            if (updateState) setLyricsSnippet(lyrics)
        } catch (e) {
            console.error('Lyrics load failed', e)
            lyricsCacheRef.current[song.id] = null
            if (updateState) setLyricsSnippet(null)
        } finally {
            if (updateState) setLyricsLoading(false)
        }
    }

    // Lyrics mode fetch (current)
    useEffect(() => {
        if (!currentSong || !isLyricsOnly) {
            setLyricsSnippet(null)
            setLyricsLoading(false)
            return
        }

        fetchLyricsForSong(currentSong, true)
    }, [currentSong?.id, isLyricsOnly])

    // Lyrics mode prefetch (next song)
    useEffect(() => {
        if (!gameState || !isLyricsOnly) return
        const nextIndex = gameState.current_round_index + 1
        const nextSong = gameState.playlist?.[nextIndex]
        if (!nextSong) return
        fetchLyricsForSong(nextSong, false)
    }, [gameState?.current_round_index, isLyricsOnly, gameState?.playlist])

    // --------------------------------------------------------------------------------
    // 3. AUDIO & TIMER (Client Side)
    // --------------------------------------------------------------------------------
    useEffect(() => {
        if (!gameState || !currentSong) return

        const isLyricsOnly = roomSettings?.mode === 'lyrics_only'
        const shouldPlayAudio = (gameState.phase === 'playing' || gameState.phase === 'reveal') && !isLyricsOnly
        const previewUrl = typeof currentSong.preview_url === 'string' ? currentSong.preview_url.trim() : ''
        const normalizedPreview = previewUrl.replace(/^http:\/\//i, 'https://')
        const hasValidPreview = normalizedPreview.length > 0 && normalizedPreview.startsWith('http')

        if (shouldPlayAudio && hasValidPreview) {
            // Check for expiration
            const matchExp = previewUrl.match(/exp=(\d+)/)
            const expTime = matchExp ? parseInt(matchExp[1]) : 0
            const nowSeconds = Math.floor(Date.now() / 1000)

            // If expired or about to expire (within 60s), refresh it
            if (expTime > 0 && expTime < nowSeconds + 60) {
                const trackId = currentSong.spotify_uri

                if (trackId && !audioRetryRef.current[previewUrl]) {
                    audioRetryRef.current[previewUrl] = true // prevent infinite loop

                    fetch(`/api/refresh-track?id=${trackId}`)
                        .then(res => res.json())
                        .then(data => {
                            if (data.preview_url) {
                                if (audioRef.current) {
                                    const newUrl = data.preview_url.replace(/^http:\/\//i, 'https://')
                                    audioRef.current.src = newUrl
                                    audioRef.current.load()
                                    audioRef.current.play()
                                        .then(() => setIsPlaying(true))
                                        .catch(e => console.error('[Audio] Play failed after refresh:', e))
                                }
                            } else {
                                console.error('[Audio] Refresh failed: No URL returned')
                            }
                        })
                        .catch(e => console.error('[Audio] Refresh Error:', e))

                    return // Wait for async refresh
                } else {
                    console.warn('[Audio] Token expired and already retried. Skipping playback.')
                    return
                }
            }

            // Normal Playback (Valid Token or No Token)
            if (audioRef.current) {
                // Only update Source if it changed (prevents reloading)
                if (normalizedPreview !== audioRef.current.src) {
                    audioRef.current.src = normalizedPreview
                    audioRef.current.load()
                }

                // Attempt playback if paused
                if (audioRef.current.paused) {
                    const playPromise = audioRef.current.play()
                    if (playPromise !== undefined) {
                        playPromise
                            .then(() => {
                                setIsPlaying(true)
                            })
                            .catch((err) => {
                                console.error('[Audio] Playback failed:', err)
                                setIsPlaying(false)
                            })
                    }
                }
            }
        } else {
            // Stop Audio
            if (audioRef.current && !audioRef.current.paused) {
                // Safeguard: Don't stop if we are in the "forced countdown" mode (phase is playing but time < 3)
                // This prevents audio cutoff when host force-reveals or countdown hits 3s
                if (gameState?.force_reveal_at && gameState?.phase === 'playing') {
                    // Do nothing, let it play
                } else {
                    audioRef.current.pause()
                    setIsPlaying(false)
                }
            }
        }
    }, [gameState?.phase, currentSong, roomSettings?.mode])

    useEffect(() => {
        if (gameState?.phase !== 'reveal') return
        if (lastRevealSoundRoundRef.current === gameState.current_round_index) return

        const me = players.find(p => p.id === profile.id)
        if (!me) return

        const correct = !!(me.last_round_correct_title || me.last_round_correct_artist)
        soundManager.play(correct ? 'correct' : 'wrong')
        lastRevealSoundRoundRef.current = gameState.current_round_index
    }, [gameState?.phase, gameState?.current_round_index, players, profile.id])

    // Timer Countdown (Synced with Server Time + Skew)
    useEffect(() => {
        if (gameState?.phase === 'playing' && gameState.round_start_time) {
            const totalTime = roomSettings?.time || 15
            const startRaw = gameState.round_start_time
            const getStartMs = () => typeof startRaw === 'number' ? startRaw : new Date(startRaw).getTime()
            const startMs = getStartMs()

            if (Number.isNaN(startMs)) return

            // Immediate update function
            const updateTimer = () => {
                const now = Date.now() + serverTimeOffset
                const elapsed = (now - startMs) / 1000
                // Use float for smooth progress bar
                const remaining = Math.max(0, totalTime - elapsed)
                const forceRaw = gameState.force_reveal_at

                let finalTime = remaining
                if (forceRaw) {
                    const forceMs = typeof forceRaw === 'number' ? forceRaw : new Date(forceRaw).getTime()
                    const forceRemaining = Math.max(0, (forceMs - now) / 1000)
                    finalTime = Math.min(remaining, forceRemaining)
                }
                setTimeLeft(finalTime)
                return finalTime
            }

            updateTimer() // run once immediately

            const interval = setInterval(() => {
                const t = updateTimer()
                if (t <= 0 && isHost) {
                    clearInterval(interval)
                    // Give a 1s Grace Period for clients to auto-submit at t=0
                    setTimeout(() => {
                        handleForceReveal()
                    }, 1000)
                }
            }, 100) // 100ms updates

            return () => clearInterval(interval)
        } else if (gameState?.phase === 'reveal') {
            setTimeLeft(0)
        }
    }, [gameState?.phase, gameState?.round_start_time, gameState?.force_reveal_at, roomSettings?.time, isHost, serverTimeOffset])

    // Lyrics: Prefetch ALL songs (Lyrics Only Mode)
    useEffect(() => {
        const mode = roomSettings?.mode || 'normal'
        if (!gameState?.playlist || mode !== 'lyrics_only') return

        const uncached = gameState.playlist.filter(song => lyricsCacheRef.current[song.id] === undefined)

        if (uncached.length > 0) {
            // Stagger fetches slightly
            uncached.forEach((song, i) => {
                setTimeout(() => fetchLyricsForSong(song, false), i * 150)
            })
        }
    }, [gameState?.playlist, roomSettings?.mode])

    // --------------------------------------------------------------------------------
    // 3. ACTIONS (Player)
    // --------------------------------------------------------------------------------
    const submitGuess = async () => {
        if (hasSubmitted || gameState?.phase !== 'playing') return
        if (gameState?.is_sudden_death && !isDuelingPlayer) return

        const currentGuess = guess // from state
        setHasSubmitted(true)
        soundManager.play('tick')
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
            navigator.vibrate(10)
        }

        // Update Firebase
        const playerRef = ref(db, `rooms/${code}/players/${profile.id}`)
        await update(playerRef, {
            has_submitted: true,
            last_guess: currentGuess,
            submitted_at: serverTimestamp() as any
        })
    }

    // Capture latest guess for auto-submit
    useEffect(() => {
        latestGuessRef.current = guess
    }, [guess])

    // Auto-Submit when time runs out (Client Side)
    // Trigger at 0, relying on Host grace period to accept it
    useEffect(() => {
        if (gameState?.phase === 'playing' && timeLeft <= 0 && !hasSubmitted && isDuelingPlayer) {
            submitGuess()
        }
    }, [gameState?.phase, timeLeft, hasSubmitted, isDuelingPlayer])

    // --------------------------------------------------------------------------------
    // 4. HOST LOGIC (State Machine)
    // --------------------------------------------------------------------------------
    const handleForceReveal = () => {
        // Trigger reveal manually (time up)
        processReveal()
    }

    // Check if everyone submitted
    useEffect(() => {
        if (!isHost || gameState?.phase !== 'playing') return

        const roundStartRaw = gameState.round_start_time
        const roundStartMs = typeof roundStartRaw === 'number'
            ? roundStartRaw
            : roundStartRaw
                ? new Date(roundStartRaw).getTime()
                : null

        const activePlayers = (gameState?.is_sudden_death && duelingIds.length > 0)
            ? players.filter(p => duelingIds.includes(p.id))
            : players

        const allSubmitted = activePlayers.length > 0 && activePlayers.every(p => {
            if (!p.has_submitted) return false
            if (!p.submitted_at) return false
            const submittedAtMs = typeof p.submitted_at === 'number'
                ? p.submitted_at
                : new Date(p.submitted_at).getTime()
            if (Number.isNaN(submittedAtMs)) return false
            if (roundStartMs && submittedAtMs < roundStartMs) return false
            return true
        })
        if (allSubmitted && activePlayers.length > 0) {
            if (timeLeft > 3 && !gameState.force_reveal_at) {
                // Force a short 3-second countdown
                update(ref(db, `rooms/${code}/game_state`), {
                    force_reveal_at: Date.now() + 3000
                })
            } else if (timeLeft <= 0) {
                processReveal()
            }
        }
    }, [players, isHost, gameState?.phase, timeLeft, gameState?.force_reveal_at, gameState?.is_sudden_death, gameState?.dueling_player_ids]) // Listen to players update

    // Keep a ref to players to avoid stale closures in timers
    useEffect(() => {
        playersRef.current = players
    }, [players])

    const getFirstTieGroup = (list: Player[], resolvedGroups: Set<string> = new Set()): string[] => {
        const groups: Record<number, Player[]> = {}
        list.forEach(p => {
            const score = p.score || 0
            if (!groups[score]) groups[score] = []
            groups[score].push(p)
        })

        const scores = Object.keys(groups).map(Number).sort((a, b) => b - a)
        for (const score of scores) {
            if (groups[score].length > 1) {
                const groupIds = groups[score].map(p => p.id).sort()
                const groupKey = groupIds.join('|')
                if (resolvedGroups.has(groupKey)) continue
                return groupIds
            }
        }
        return []
    }

    const processReveal = async () => {
        if (!isHost) return

        // Prevention: Double Execution Lock
        // We need to fetch the latest state first to be sure, but we can check the local state hint first
        if (gameState && processingRoundRef.current === gameState.current_round_index) {
            return
        }

        // 1. Fetch Authoritative Data from DB (Avoid Stale Closures & Race Conditions)
        // We wait 1s grace period before this runs, so DB should be up to date.
        const roomRef = ref(db, `rooms/${code}`)
        const snapshot = await get(roomRef)
        const roomData = snapshot.val()

        if (!roomData || !roomData.game_state || !roomData.players) {
            console.error('[processReveal] Failed to fetch room data')
            return
        }

        const currentGameState = roomData.game_state as GameState
        const currentPlayers = Object.values(roomData.players) as Player[]
        // Use the playlist from local state if DB playlist is huge/truncating, 
        // but ideally DB has it. For now, trust DB game_state.
        // Actually, playlist might be large so be careful. 
        // Let's rely on local 'gameState.playlist' for the song object to save bandwidth 
        // IF we trust it hasn't changed. The playlist shouldn't change mid-round.
        // But 'current_round_index' MUST be fresh.

        const roundIndex = currentGameState.current_round_index

        // Double Check Lock with authoritative index
        if (processingRoundRef.current === roundIndex) {
            return
        }
        processingRoundRef.current = roundIndex

        const currentSong = (gameState?.playlist || [])[roundIndex] // Use local playlist for speed/size

        const currentIsSuddenDeath = currentGameState.is_sudden_death

        // console.log(`[processReveal] Current Song:`, currentSong)

        if (!currentSong) {
            console.error('[processReveal] No song found for index', roundIndex)
            return
        }

        const totalTime = roomSettings?.time || 15
        const mode = roomSettings?.mode || 'normal'
        const roundStartRaw = currentGameState.round_start_time
        const roundStartMs = typeof roundStartRaw === 'number'
            ? roundStartRaw
            : roundStartRaw
                ? new Date(roundStartRaw).getTime()
                : null

        const updates: Record<string, any> = {}
        const roundGuesses: any[] = []
        const roundPoints: Record<string, number> = {}

        const scoringPlayers = (currentIsSuddenDeath && (currentGameState.dueling_player_ids || []).length > 0)
            ? currentPlayers.filter(p => (currentGameState.dueling_player_ids || []).includes(p.id))
            : currentPlayers

        scoringPlayers.forEach(p => {
            // Calculate
            const g = p.last_guess || { artist: '', title: '' }
            const submittedRaw = p.submitted_at
            const submittedAtMs = typeof submittedRaw === 'number'
                ? submittedRaw
                : submittedRaw
                    ? new Date(submittedRaw).getTime()
                    : null


            const timeTaken = (submittedAtMs && roundStartMs)
                ? Math.max(0, (submittedAtMs - roundStartMs) / 1000)
                : totalTime
            const clampedTimeTaken = Math.min(totalTime, timeTaken)
            const timeLeftForPlayer = Math.max(0, totalTime - clampedTimeTaken)
            const scoreData = calculateScore(
                { artist: g.artist, title: g.title },
                { artist: currentSong.artist_name, title: currentSong.track_name },
                timeLeftForPlayer,
                totalTime,
                mode,
                currentIsSuddenDeath // Pass sudden death flag
            )

            // Queue Updates
            if (currentIsSuddenDeath) {
                // SUDDEN DEATH: Update separate score, do NOT touch main score
                const currentSD = p.sudden_death_score || 0
                // In Sudden Death, use SD score
                const earned = scoreData.points

                // Update SD Score
                const oldSD = p.sudden_death_score || 0
                updates[`rooms/${code}/players/${p.id}/sudden_death_score`] = oldSD + earned

                // DO NOT add to main score (Sudden Death is separate tie-breaker)
                // updates[`rooms/${code}/players/${p.id}/score`] = (p.score || 0) + earned

                roundPoints[p.id] = earned
            } else {
                // Normal Mode
                updates[`rooms/${code}/players/${p.id}/score`] = (p.score || 0) + scoreData.points
                roundPoints[p.id] = scoreData.points
            }

            updates[`rooms/${code}/players/${p.id}/last_round_points`] = scoreData.points
            updates[`rooms/${code}/players/${p.id}/last_round_correct_artist`] = scoreData.correctArtist
            updates[`rooms/${code}/players/${p.id}/last_round_correct_title`] = scoreData.correctTitle
            updates[`rooms/${code}/players/${p.id}/last_round_time_taken`] = clampedTimeTaken

            roundGuesses.push({
                user_id: p.id,
                username: p.username,
                avatar_url: p.avatar_url,
                guess_title: g.title || '',
                guess_artist: g.artist || '',
                correct_title: scoreData.correctTitle,
                correct_artist: scoreData.correctArtist,
                is_correct: scoreData.correctTitle || scoreData.correctArtist,
                points: scoreData.points,
                time_taken: clampedTimeTaken
            })
        })

        // 2. Update Game Phase to Reveal
        updates[`rooms/${code}/game_state/phase`] = 'reveal'
        updates[`rooms/${code}/game_state/reveal_start_time`] = serverTimestamp() as any
        updates[`rooms/${code}/game_state/force_reveal_at`] = null

        // 2.5 Persist Round History for Recap
        updates[`rooms/${code}/round_history/${currentGameState.current_round_index}`] = {
            round_index: currentGameState.current_round_index,
            song_id: currentSong.id,
            track_name: currentSong.track_name,
            artist_name: currentSong.artist_name,
            cover_url: currentSong.cover_url,
            picked_by_user_id: currentSong.picked_by_user_id,
            started_at: currentGameState.round_start_time || null,
            ended_at: serverTimestamp() as any,
            guesses: roundGuesses
        }

        await update(ref(db), updates)

        // 3. Schedule Next Round or Finish
        const updatedPlayers = currentPlayers.map(p => {
            const pointsEarned = roundPoints[p.id] || 0
            if (currentIsSuddenDeath) {
                return { ...p, sudden_death_score: (p.sudden_death_score || 0) + pointsEarned, score: (p.score || 0) + pointsEarned }
            } else {
                return { ...p, score: (p.score || 0) + pointsEarned }
            }
        })

        const revealMs = 5000

        setTimeout(async () => {
            const nextIndex = currentGameState.current_round_index + 1
            const totalSongs = currentGameState.playlist.length

            // SUDDEN DEATH: Check if we need more songs
            if (currentIsSuddenDeath) {
                const duelingIds = currentGameState.dueling_player_ids || []
                const duelingPlayers = updatedPlayers.filter(p => duelingIds.includes(p.id))


                if (duelingPlayers.length >= 2) {
                    // Sort by SUDDEN DEATH SCORE
                    const sorted = [...duelingPlayers].sort((a, b) => (b.sudden_death_score || 0) - (a.sudden_death_score || 0))
                    const leaderScore = sorted[0]?.sudden_death_score || 0
                    const secondScore = sorted[1]?.sudden_death_score || 0
                    const restScores = sorted.slice(1).map(p => p.sudden_death_score || 0)
                    const restHasTie = restScores.length > 1 && new Set(restScores).size !== restScores.length


                    // Win-by-2 rule
                    if (leaderScore >= secondScore + 2 && !restHasTie) {
                        const resolvedGroups = new Set(currentGameState.resolved_tie_groups || [])
                        const finishedGroupKey = [...duelingIds].sort().join('|')
                        if (finishedGroupKey) resolvedGroups.add(finishedGroupKey)

                        const nextTieGroup = getFirstTieGroup(updatedPlayers, resolvedGroups)

                        if (nextTieGroup.length > 1) {
                            // Another tie exists! Start next duel
                            await initiateSuddenDeath(code, nextTieGroup, currentGameState, updatedPlayers, Array.from(resolvedGroups))
                            return
                        } else {
                            // No more ties -> Game Over. Clear SD flag.
                            await update(ref(db, `rooms/${code}`), {
                                status: 'finished',
                                'game_state/phase': 'end',
                                'game_state/end_time': Date.now(),
                                'game_state/is_sudden_death': false,
                                'game_state/resolved_tie_groups': Array.from(resolvedGroups)
                            })
                            return
                        }
                    } else {
                        // Duel continues
                    }
                }
            }

            // Normal End of Game Check
            const MAX_ROUNDS = roomSettings?.rounds || 5
            if (currentGameState.current_round_index >= MAX_ROUNDS - 1 && !currentIsSuddenDeath) {
                // Check for ties
                const resolvedGroups = new Set(currentGameState.resolved_tie_groups || [])
                const tieGroup = getFirstTieGroup(updatedPlayers, resolvedGroups)
                if (tieGroup.length > 1) {
                    await initiateSuddenDeath(code, tieGroup, currentGameState, updatedPlayers, Array.from(resolvedGroups))
                } else {
                    await update(ref(db, `rooms/${code}`), {
                        status: 'finished',
                        'game_state/phase': 'end',
                        'game_state/end_time': Date.now()
                    })
                }
            } else {
                // Next Round (Normal or Sudden Death continues)
                // If we are in SD and didn't trigger game over, we default here to next song
                const nextRound = currentGameState.current_round_index + 1

                await update(ref(db, `rooms/${code}`), {
                    'game_state/phase': 'playing',
                    'game_state/current_round_index': nextRound,
                    'game_state/round_start_time': Date.now(),
                    'game_state/force_reveal_at': null, // Clear any force reveal
                    // Reset submissions
                    ...Object.fromEntries(currentPlayers.map(p => [`players/${p.id}/has_submitted`, false])),
                    ...Object.fromEntries(currentPlayers.map(p => [`players/${p.id}/last_guess`, null])),
                    ...Object.fromEntries(currentPlayers.map(p => [`players/${p.id}/last_round_score`, 0])),
                    ...Object.fromEntries(currentPlayers.map(p => [`players/${p.id}/last_round_correct_artist`, false])),
                    ...Object.fromEntries(currentPlayers.map(p => [`players/${p.id}/last_round_correct_title`, false]))
                })

                // If SD, check if need more songs
                if (currentIsSuddenDeath) {
                    const remainingSongs = totalSongs - nextIndex
                    const requiredBuffer = Math.max(2, (currentGameState.dueling_player_ids?.length || 2) * 2)

                    // Fetch more if running low
                    if (remainingSongs < requiredBuffer) {
                        const fetched = await fetchMoreSuddenDeathSongs(code, currentGameState)
                        if (!fetched) {
                            console.warn('[SuddenDeath] Could not fetch more songs!')
                        }
                    }
                }
            }
        }, revealMs)
    }

    // --------------------------------------------------------------------------------
    // 5. RENDER
    // --------------------------------------------------------------------------------

    // A. Finished -> Podium
    if (status === 'finished') {
        return <GameRecap roomCode={code} players={players} />
    }

    if (!gameState || !currentSong) return <div className="flex-center" style={{ height: '100vh' }}>Loading Game...</div>

    // B. VS Screen (Sudden Death Intro)
    if (gameState.phase === 'vs_screen') {
        const duelingPlayers = players.filter(p =>
            gameState.dueling_player_ids?.includes(p.id)
        )

        return (
            <div className="flex-center" style={{ flexDirection: 'column', height: '100vh', gap: '40px' }}>
                <h1 className="text-gradient" style={{ fontSize: '5rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '4px' }}>
                    ⚔️ SUDDEN DEATH ⚔️
                </h1>

                <div style={{ display: 'flex', gap: '80px', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
                    {duelingPlayers.map((p, idx) => (
                        <div key={p.id} style={{ textAlign: 'center', animation: 'pulse 1.5s ease-in-out infinite' }}>
                            <div style={{ width: '180px', height: '180px', borderRadius: '50%', overflow: 'hidden', border: '5px solid #FFD700', boxShadow: '0 0 40px rgba(255, 215, 0, 0.5)', margin: '0 auto' }}>
                                <img src={p.avatar_url} alt={p.username} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            </div>
                            <h2 style={{ marginTop: '24px', fontSize: '2rem', fontWeight: 700 }}>{p.username}</h2>
                            <div style={{ fontSize: '2.5rem', fontWeight: 900, color: '#FFD700', marginTop: '8px' }}>
                                {p.sudden_death_score || 0} <span style={{ fontSize: '1rem', verticalAlign: 'middle' }}>SD Pts</span>
                            </div>
                        </div>
                    ))}
                </div>

                <div style={{ fontSize: '1.8rem', opacity: 0.9, fontWeight: 600, textAlign: 'center', maxWidth: '600px' }}>
                    {duelingPlayers.length === 2 ? 'Head to Head' : 'Multi-Way Tie'} · First to break wins
                </div>
            </div>
        )
    }

    const isReveal = gameState.phase === 'reveal'
    const displayRound = gameState.is_sudden_death ? (roomSettings?.rounds || (gameState.current_round_index + 1)) : (gameState.current_round_index + 1)
    const displayPlayers = (isSuddenDeath && duelingIds.length > 0)
        ? players.filter(p => duelingIds.includes(p.id))
        : players

    return (
        <div className="game-shell" style={{ width: '100%', margin: '0 auto', paddingBottom: '28px', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

            {/* Top HUD */}
            <div className="game-hud">
                <div className="hud-row">
                    <div className="round-pill">
                        {gameState.is_sudden_death && <span className="round-tag">Sudden Death</span>}
                        <span>Round {displayRound} / {roomSettings?.rounds}</span>
                    </div>
                    <div className={`timer-pill ${gameState.phase === 'playing' && timeLeft <= 3 ? 'countdown-pulse' : ''}`}>
                        {timeSynced ? Math.ceil(Math.max(0, timeLeft)) : '...'}
                    </div>
                </div>
                <div className="hud-progress">
                    <ProgressBar current={timeSynced ? Math.max(0, timeLeft) : 0} total={roomSettings?.time || 15} />
                </div>
            </div>

            {/* Main Game Area */}
            <div className="game-stage animate-in" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px', position: 'relative', overflow: 'hidden' }}>
                <div className="game-core">
                    {/* Album Cover Area (Hidden until Reveal, unless not lyrics mode) */}
                    {(!isLyricsOnly || isReveal) && (
                        <div
                            className={`vinyl-container ${isPlaying ? 'spinning' : ''} ${isReveal ? 'reveal' : ''}`}
                            style={{ marginBottom: '32px' }}
                        >
                            <div className="vinyl-grooves" />
                            <div className={`vinyl-label ${isReveal ? 'reveal' : ''}`}>
                                {isReveal ? (
                                    <img
                                        className="vinyl-cover"
                                        src={currentSong.cover_url}
                                        style={{
                                            width: '100%', height: '100%', objectFit: 'cover',
                                            borderRadius: '50%'
                                        }}
                                    />
                                ) : (
                                    <Music size={40} style={{ opacity: 0.3 }} />
                                )}
                                <div className="vinyl-hole" />
                            </div>
                        </div>
                    )}

                    {/* Question / Inputs */}
                    {isReveal ? (
                        <div style={{ textAlign: 'center', animation: 'fadeIn 0.5s', width: '100%' }}>
                            {currentSong.picked_by_user_id === profile.id && (
                                <div style={{ marginBottom: '12px', fontWeight: 700, color: '#FFD700' }}>
                                    This was your song
                                </div>
                            )}
                            <h2 className="text-gradient" style={{ fontSize: '2rem', fontWeight: 900, marginBottom: '8px' }}>
                                {currentSong.track_name}
                            </h2>
                            <h3 style={{ fontSize: '1.5rem', color: '#ccc' }}>
                                {currentSong.artist_name}
                            </h3>
                            {songPicker && !isMySong && (
                                <div className="song-credit">
                                    <img src={songPicker.avatar_url} alt={songPicker.username} />
                                    <span>{songPicker.username} added this song</span>
                                </div>
                            )}

                            <div style={{ marginTop: '18px', width: '100%', maxWidth: '520px', marginLeft: 'auto', marginRight: 'auto' }}>
                                <div style={{ fontWeight: 700, marginBottom: '10px', opacity: 0.9 }}>Round Results</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {displayPlayers.map(p => {
                                        const correct = (p.last_round_correct_title || p.last_round_correct_artist)
                                        return (
                                            <div key={p.id} style={{
                                                display: 'flex', alignItems: 'center', gap: '12px',
                                                padding: '8px 12px', borderRadius: '10px',
                                                background: correct ? 'rgba(30, 215, 96, 0.08)' : 'rgba(233, 20, 41, 0.08)',
                                                border: `1px solid ${correct ? 'rgba(30, 215, 96, 0.22)' : 'rgba(233, 20, 41, 0.22)'}`
                                            }}>
                                                <img src={p.avatar_url} style={{ width: '32px', height: '32px', borderRadius: '50%' }} />
                                                <div style={{ flex: 1 }}>
                                                    <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{p.username}</div>
                                                    <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>
                                                        {correct ? '✅ Correct' : '❌ Wrong'}
                                                    </div>
                                                </div>
                                                <div style={{ fontWeight: 800, color: correct ? '#1ed760' : '#e91429' }}>
                                                    {correct ? `+${p.last_round_points ?? 0}` : '0'}
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>

                            <div style={{ marginTop: '16px', fontWeight: 'bold' }}>
                                Next round starting...
                            </div>
                        </div>
                    ) : (
                        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
                            {isLyricsOnly && (
                                <div className="lyrics-panel">
                                    {lyricsLoading ? (
                                        <div className="lyrics-skeleton">
                                            <span />
                                            <span />
                                            <span />
                                            <span />
                                        </div>
                                    ) : (
                                        lyricsSnippet || 'Lyrics unavailable for this song.'
                                    )}
                                </div>
                            )}

                            <div style={{ width: '100%', maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                {showTitleInput && (
                                    <input
                                        ref={titleInputRef}
                                        type="text" placeholder="Guess the Song Title..."
                                        className="input-field"
                                        value={guess.title}
                                        onChange={(e) => setGuess(prev => ({ ...prev, title: e.target.value }))}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault()
                                                if (showArtistInput) {
                                                    artistInputRef.current?.focus()
                                                } else {
                                                    submitGuess()
                                                }
                                            }
                                        }}
                                        disabled={hasSubmitted || !canGuess}
                                    />
                                )}
                                {showArtistInput && (
                                    <input
                                        ref={artistInputRef}
                                        type="text" placeholder="Guess the Artist..."
                                        className="input-field"
                                        value={guess.artist}
                                        onChange={(e) => setGuess(prev => ({ ...prev, artist: e.target.value }))}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault()
                                                submitGuess()
                                            }
                                        }}
                                        disabled={hasSubmitted || !canGuess}
                                    />
                                )}
                                <button
                                    className="btn-primary"
                                    onClick={submitGuess}
                                    disabled={hasSubmitted || !canGuess}
                                >
                                    {hasSubmitted ? 'ANSWER SUBMITTED' : 'SUBMIT GUESS'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* In-Game Leaderboard */}
            <div className="game-leaderboard">
                <div className="leaderboard-title">Leaderboard</div>
                {[...displayPlayers].sort((a, b) => {
                    // Primary: Main Score
                    if (b.score !== a.score) return b.score - a.score
                    // Secondary: Sudden Death Score
                    return (b.sudden_death_score || 0) - (a.sudden_death_score || 0)
                }).map(p => {
                    const isSubmitter = p.has_submitted
                    const isMe = p.id === profile.id

                    // Check if correct during reveal
                    let resultClass = ''
                    if (isReveal && p.last_guess) {
                        const correctTitle = p.last_round_correct_title ?? false
                        const correctArtist = p.last_round_correct_artist ?? false
                        const isCorrect = correctTitle || correctArtist
                        resultClass = isCorrect ? 'correct' : 'wrong'
                    }

                    return (
                        <div
                            key={p.id}
                            className={`player-card ${isSubmitter ? 'submitted' : ''} ${resultClass} ${isMe ? 'me' : ''}`}
                        >
                            <img src={p.avatar_url} style={{ width: '32px', height: '32px', borderRadius: '50%' }} />
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>{p.username}</div>
                                <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                                    {gameState.is_sudden_death
                                        ? `${p.sudden_death_score || 0} pts (SD)`
                                        : `${p.score} pts`
                                    }
                                </div>
                            </div>
                            {isSubmitter && !isReveal && <Check size={16} className="text-primary" />}
                            {isReveal && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: resultClass === 'correct' ? '#1ed760' : '#e91429' }}>
                                        {resultClass === 'correct' ? `+${p.last_round_points ?? 0}` : '0'}
                                    </span>
                                    <span style={{ fontSize: '0.9rem' }}>
                                        {resultClass === 'correct' ? '✅' : '❌'}
                                    </span>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>

            {/* Footer: Score & Emotes */}
            <div className="score-hud">
                Score: <span className="text-primary">{totalScore}</span>
            </div>
            {/* Audio Element Hidden */}
            <audio
                ref={onAudioRefChange}
                preload="auto"
                style={{ display: 'none' }}
                onError={(e) => {
                    console.error('[Audio] Element Error:', e.currentTarget.error)
                    // Try to force reload if generic error?
                    // e.currentTarget.load() // Careful with infinite loops
                }}
            />

            <EmoteBar roomCode={code} />
        </div>
    )
}
