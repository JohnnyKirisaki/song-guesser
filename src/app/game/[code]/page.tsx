'use client'

import { useEffect, useState, useRef, type MouseEvent, type SyntheticEvent } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { db } from '@/lib/firebase'
import { ref, onValue, update, get, serverTimestamp, onDisconnect } from 'firebase/database'
import { useUser } from '@/context/UserContext'
import { GameState, SongItem } from '@/lib/game-logic'
import { useVolume } from '@/context/VolumeContext'

import { Music, Check } from 'lucide-react'
import ProgressBar from '@/components/ProgressBar'
import { soundManager } from '@/lib/sounds'
import { processNextRound } from '@/lib/game-round-manager'
import EmoteBar from '@/components/EmoteBar'
import Onboarding from '@/components/Onboarding'
import GameRecap from '@/components/GameRecap'
import { initiateSuddenDeath, fetchMoreSuddenDeathSongs, endSuddenDeath } from '@/lib/sudden-death'
import UserPopover from '@/components/UserPopover'

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
    const [showRevealLyricsFetch, setShowRevealLyricsFetch] = useState(false)
    const [pendingRevealLyricsFetch, setPendingRevealLyricsFetch] = useState(false)

    const [serverTimeOffset, setServerTimeOffset] = useState(0)
    const [isRevealing, setIsRevealing] = useState(false) // New state for API call loading
    const [revealError, setRevealError] = useState<string | null>(null) // Capture API/Network errors

    const { volume } = useVolume()
    const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null)
    const [menuAnchor, setMenuAnchor] = useState<{ x: number, y: number } | null>(null)

    const openUserMenu = (user: Player, event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        setSelectedPlayer(user)
        setMenuAnchor({ x: event.clientX, y: event.clientY })
    }

    const closeUserMenu = () => {
        setSelectedPlayer(null)
        setMenuAnchor(null)
    }

    const handleAudioError = (_e: SyntheticEvent<HTMLAudioElement, Event>) => {
        const song = currentSong
        if (!song) return

        const trackId = song.spotify_uri
        if (!trackId) return

        setIsPlaying(false)

        const key = song.id || trackId
        const lastErrorAt = audioErrorRef.current[key] || 0
        if (Date.now() - lastErrorAt < 10000) {
            return
        }
        audioErrorRef.current[key] = Date.now()

        resolvePreviewForSong(song)
            .then((newUrl) => {
                if (!newUrl || !audioRef.current) return
                audioRef.current.src = newUrl
                lastAudioSrcRef.current = newUrl
                audioRef.current.load()
                audioRef.current.play()
                    .then(() => setIsPlaying(true))
                    .catch(err => console.error('[Audio] Play failed after error refresh:', err))
            })
            .catch(err => {
                console.error('[Audio] Refresh after error failed:', err)
            })
    }

    // Refs
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const audioRetryRef = useRef<Record<string, number>>({})
    const lastRevealSoundRoundRef = useRef<number | null>(null)
    const playersRef = useRef<Player[]>([]) // Authoritative ref to avoid stale closures
    const gameStateRef = useRef<GameState | null>(null)
    const hasScheduledNextRoundRef = useRef(false)
    const sdTopUpRoundRef = useRef<number | null>(null)
    const latestGuessRef = useRef({ artist: '', title: '' }) // Latest text input
    const hasSubmittedRef = useRef(false) // Ref for sync logic to avoid stale closure
    const titleInputRef = useRef<HTMLInputElement | null>(null)
    const artistInputRef = useRef<HTMLInputElement | null>(null)
    const lyricsCacheRef = useRef<Record<string, string | null>>({})
    const processingRoundRef = useRef<number | null>(null) // Prevention for double-execution
    const lastAudioSrcRef = useRef<string | null>(null)
    const audioPreviewOverrideRef = useRef<Record<string, string>>({})
    const audioErrorRef = useRef<Record<string, number>>({})

    const resolvePreviewForSong = async (song: SongItem): Promise<string | null> => {
        if (!song) return null
        const cached = audioPreviewOverrideRef.current[song.id]
        if (cached) return cached

        const trackId = song.spotify_uri
        const isDeezerId = typeof trackId === 'string' && /^\d+$/.test(trackId)

        try {
            if (isDeezerId) {
                const res = await fetch(`/api/refresh-track?id=${trackId}`)
                const data = await res.json()
                if (data.preview_url) {
                    const newUrl = data.preview_url.replace(/^http:\/\//i, 'https://')
                    audioPreviewOverrideRef.current[song.id] = newUrl
                    return newUrl
                }
            }

            if (song.artist_name && song.track_name) {
                const res = await fetch('/api/resolve-tracks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tracks: [{ artist: song.artist_name, title: song.track_name }]
                    })
                })
                const data = await res.json()
                const resolved = data?.tracks?.find((t: any) => t?.resolved && t?.deezer?.preview_url)
                if (resolved?.deezer?.preview_url) {
                    const newUrl = resolved.deezer.preview_url.replace(/^http:\/\//i, 'https://')
                    audioPreviewOverrideRef.current[song.id] = newUrl
                    return newUrl
                }
            }
        } catch (err) {
            console.error('[Audio] Preview resolve failed:', err)
        }

        return null
    }

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

            // Local Flicker Prevention:
            // Immediately clear "Correct" status on round transition so we don't show old "Green" tags
            // while waiting for next API result.
            setPlayers(prev => prev.map(p => ({
                ...p,
                last_round_correct_artist: false,
                last_round_correct_title: false,
                is_correct: false,
                last_round_points: 0
            })))
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

            const artist = typeof song.artist_name === 'string' ? song.artist_name.trim() : ''
            const title = typeof song.track_name === 'string' ? song.track_name.trim() : ''
            const hasRealMetadata = !!artist && !!title && artist !== '???' && title !== '???'

            if (!hasRealMetadata) {
                // Avoid invalid API requests for masked songs (e.g. sudden death)
                if (updateState) {
                    setLyricsSnippet(null)
                    setLyricsLoading(false)
                }
                return
            }

            // Fallback: Fetch API
            const res = await fetch(`/api/lyrics?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`)
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

    // Reset audio retry state per song to avoid stale "already retried" blocks
    useEffect(() => {
        audioRetryRef.current = {}
    }, [currentSong?.id])

    // Only show "Fetching lyrics..." during reveal screen
    useEffect(() => {
        if (gameState?.phase !== 'reveal') return
        if (!pendingRevealLyricsFetch) return

        setShowRevealLyricsFetch(true)
        const t = setTimeout(() => {
            setShowRevealLyricsFetch(false)
            setPendingRevealLyricsFetch(false)
        }, 900)

        return () => clearTimeout(t)
    }, [gameState?.phase, pendingRevealLyricsFetch])

    // --------------------------------------------------------------------------------
    // 3. AUDIO & TIMER (Client Side)
    // --------------------------------------------------------------------------------
    useEffect(() => {
        if (!gameState || !currentSong) return

        const isLyricsOnly = roomSettings?.mode === 'lyrics_only'
        const shouldPlayAudio = gameState.phase === 'reveal' || (!isLyricsOnly && gameState.phase === 'playing')
        const previewUrl = typeof currentSong.preview_url === 'string' ? currentSong.preview_url.trim() : ''
        const normalizedPreview = previewUrl.replace(/^http:\/\//i, 'https://')
        const overridePreview = currentSong?.id ? audioPreviewOverrideRef.current[currentSong.id] : null
        const previewToUse = overridePreview || normalizedPreview
        const hasValidPreview = previewToUse.length > 0 && previewToUse.startsWith('http')
        const retryKey = currentSong.id || previewToUse
        const lastRetryAt = audioRetryRef.current[retryKey] || 0
        const canRetry = !lastRetryAt || (Date.now() - lastRetryAt) > 10000
        const nowSeconds = Math.floor(Date.now() / 1000)

        const playUrl = (url: string) => {
            if (!audioRef.current) return
            if (url !== lastAudioSrcRef.current) {
                audioRef.current.src = url
                lastAudioSrcRef.current = url
                audioRef.current.load()
            }
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
                            const msg = typeof err?.message === 'string' ? err.message : ''
                            const isNotSupported = err?.name === 'NotSupportedError' || msg.includes('no supported source')
                            if (isNotSupported) {
                                const key = currentSong.id || url
                                const lastErr = audioErrorRef.current[key] || 0
                                if (Date.now() - lastErr > 10000) {
                                    audioErrorRef.current[key] = Date.now()
                                    resolvePreviewForSong(currentSong)
                                        .then((newUrl) => {
                                            if (!newUrl || !audioRef.current) return
                                            audioRef.current.src = newUrl
                                            lastAudioSrcRef.current = newUrl
                                            audioRef.current.load()
                                            return audioRef.current.play()
                                                .then(() => setIsPlaying(true))
                                                .catch(e => console.error('[Audio] Playback failed after resolve:', e))
                                        })
                                        .catch(e => console.error('[Audio] Resolve after NotSupported failed:', e))
                                }
                            }
                        })
                }
            }
        }

        if (shouldPlayAudio) {
            // Lyrics mode: only reveal audio, and avoid expired Spotify previews
            if (isLyricsOnly && gameState.phase === 'reveal') {
                const matchExp = previewToUse.match(/exp=(\d+)/)
                const expTime = matchExp ? parseInt(matchExp[1]) : 0
                const isExpired = expTime > 0 && expTime < nowSeconds + 60

                if (overridePreview && hasValidPreview && !isExpired) {
                    playUrl(previewToUse)
                    return
                }

                if (!hasValidPreview || isExpired) {
                    if (canRetry) {
                        audioRetryRef.current[retryKey] = Date.now()
                        resolvePreviewForSong(currentSong)
                            .then((newUrl) => {
                                if (newUrl) {
                                    playUrl(newUrl)
                                } else {
                                    console.error('[Audio] Refresh failed: No URL returned')
                                }
                            })
                            .catch(e => {
                                console.error('[Audio] Refresh Error:', e)
                            })
                    } else {
                        console.warn('[Audio] Token expired and already retried. Skipping playback.')
                    }
                    return
                }

                playUrl(previewToUse)
                return
            }

            if (!hasValidPreview) return

            // Check for expiration
            const matchExp = previewToUse.match(/exp=(\d+)/)
            const expTime = matchExp ? parseInt(matchExp[1]) : 0

            // If expired or about to expire (within 60s), refresh it
            if (expTime > 0 && expTime < nowSeconds + 60) {
                if (canRetry) {
                    audioRetryRef.current[retryKey] = Date.now() // prevent infinite loop

                    resolvePreviewForSong(currentSong)
                        .then((newUrl) => {
                            if (newUrl) {
                                playUrl(newUrl)
                            } else {
                                console.error('[Audio] Refresh failed: No URL returned')
                            }
                        })
                        .catch(e => {
                            console.error('[Audio] Refresh Error:', e)
                        })

                    return // Wait for async refresh
                } else {
                    console.warn('[Audio] Token expired and already retried. Skipping playback.')
                    return
                }
            }

            playUrl(previewToUse)
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

        const correct = me.last_round_correct_title === true || me.last_round_correct_artist === true
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
            } else if (timeLeft <= 0 && !revealError) {
                processReveal()
            }
        }
    }, [players, isHost, gameState?.phase, timeLeft, gameState?.force_reveal_at, gameState?.is_sudden_death, gameState?.dueling_player_ids, revealError]) // Listen to players update

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

        const scores = Object.keys(groups).map(Number).sort((a, b) => a - b)
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

    useEffect(() => {
        gameStateRef.current = gameState
    }, [gameState])

    // Reset schedule ref when playing
    useEffect(() => {
        if (gameState?.phase === 'playing') {
            hasScheduledNextRoundRef.current = false
        }
    }, [gameState?.phase])

    // Orchestrate Next Round when in Reveal Phase
    useEffect(() => {
        if (!isHost || gameState?.phase !== 'reveal') return
        if (hasScheduledNextRoundRef.current) return

        if (gameState?.is_sudden_death) {
            const remainingSongs = gameState.playlist.length - (gameState.current_round_index + 1)
            if (remainingSongs <= 0) {
                // Wait for SD top-up during reveal before proceeding.
                return
            }
        }

        hasScheduledNextRoundRef.current = true

        const revealMs = 5000

        setTimeout(async () => {
            const currentGameState = gameStateRef.current
            const currentPlayers = playersRef.current
            // Safety checks
            if (!currentGameState || !currentPlayers) return

            const code = params.code as string

            await processNextRound(code, currentGameState, currentPlayers, roomSettings || {})
        }, revealMs)

    }, [gameState?.phase, isHost]) // Runs when phase changes to reveal

    // Sudden Death: fetch more songs during reveal (after results show)
    useEffect(() => {
        if (!isHost) return
        if (!gameState || gameState.phase !== 'reveal') return
        if (!gameState.is_sudden_death) return

        if (sdTopUpRoundRef.current === gameState.current_round_index) return

        const totalSongs = gameState.playlist.length
        const remainingSongs = totalSongs - (gameState.current_round_index + 1)

        if (remainingSongs > 0) return

        sdTopUpRoundRef.current = gameState.current_round_index
        fetchMoreSuddenDeathSongs(code, gameState)
            .then((fetched) => {
                if (!fetched) return
                if (hasScheduledNextRoundRef.current) return

                const revealMs = 5000
                const startRaw = gameStateRef.current?.reveal_start_time
                const startMs = typeof startRaw === 'number'
                    ? startRaw
                    : startRaw
                        ? new Date(startRaw).getTime()
                        : 0
                const elapsed = startMs ? Date.now() - startMs : revealMs
                const delay = Math.max(0, revealMs - elapsed)

                hasScheduledNextRoundRef.current = true
                setTimeout(async () => {
                    const currentGameState = gameStateRef.current
                    const currentPlayers = playersRef.current
                    if (!currentGameState || !currentPlayers) return
                    await processNextRound(code, currentGameState, currentPlayers, roomSettings || {})
                }, delay)
            })
            .catch((e) => {
                console.warn('[SuddenDeath] Could not fetch more songs (reveal top-up)', e)
            })
    }, [isHost, gameState?.phase, gameState?.is_sudden_death, gameState?.current_round_index, gameState?.playlist?.length, code])

    const processReveal = async () => {
        if (!isHost) return

        // Prevention: Double Execution Lock
        if (gameState && processingRoundRef.current === gameState.current_round_index) {
            return
        }

        if (!gameState) return

        const shouldShowRevealFetch = () => {
            if (roomSettings?.mode !== 'lyrics_only') return false
            if (!gameState) return false

            if (gameState.is_sudden_death) {
                const start = gameState.sudden_death_start_index ?? gameState.current_round_index
                const sdRound = gameState.current_round_index - start
                if (sdRound >= 0 && (sdRound + 1) % 5 === 0) return true
                return false
            }

            const currentMissing = currentSong
                ? (lyricsCacheRef.current[currentSong.id] === undefined || lyricsCacheRef.current[currentSong.id] === null)
                : false

            const nextSong = gameState.playlist?.[gameState.current_round_index + 1]
            const nextMissing = nextSong
                ? (lyricsCacheRef.current[nextSong.id] === undefined || lyricsCacheRef.current[nextSong.id] === null)
                : false

            return currentMissing || nextMissing
        }

        processingRoundRef.current = gameState.current_round_index
        setIsRevealing(true) // Start loading UI
        if (shouldShowRevealFetch()) {
            setPendingRevealLyricsFetch(true)
        }
        setRevealError(null)

        try {
            const res = await fetch('/api/game/reveal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    roomCode: code,
                    roundIndex: gameState.current_round_index
                })
            })

            if (!res.ok) {
                // If 404 or 500, throw to catch block
                const errData = await res.json().catch(() => ({}))
                throw new Error(errData.error || `Server returned ${res.status}`)
            }

        } catch (e: any) {
            console.error('Reveal failed', e)
            setRevealError(e.message || 'Reveal failed')
            setPendingRevealLyricsFetch(false)
            processingRoundRef.current = null // Reset lock if failed
        } finally {
            setIsRevealing(false) // Stop loading UI
        }
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

                {isLyricsOnly && (
                    <div
                        style={{
                            marginTop: '20px',
                            color: '#FFD700',
                            fontSize: '1.2rem',
                            fontWeight: 600,
                            animation: 'pulse 1s infinite',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px'
                        }}
                    >
                        <div className="animate-spin" style={{ width: '20px', height: '20px', border: '3px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%' }} />
                        FETCHING NEW SUDDEN DEATH LYRICS...
                    </div>
                )}


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
                    {/* Inject Loading Indicator during Reveal only */}
                    {showRevealLyricsFetch && isLyricsOnly && isReveal && (
                        <div className="reveal-loading-pill" style={{
                            background: 'rgba(255, 215, 0, 0.2)', color: '#FFD700',
                            border: '1px solid rgba(255, 215, 0, 0.4)', padding: '4px 12px',
                            borderRadius: '99px', fontSize: '0.8rem', fontWeight: 700,
                            display: 'flex', alignItems: 'center', gap: '8px'
                        }}>
                            <div className="animate-spin" style={{ width: '12px', height: '12px', border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%' }} />
                            FETCHING NEW LYRICS...
                        </div>
                    )}
                    <div className={`timer-pill ${gameState.phase === 'playing' && timeLeft <= 3 ? 'countdown-pulse' : ''}`}>
                        {timeSynced ? Math.ceil(Math.max(0, timeLeft)) : '...'}
                    </div>
                </div>
                <div className="hud-progress">
                    <ProgressBar current={timeSynced ? Math.max(0, timeLeft) : 0} total={roomSettings?.time || 15} />
                </div>
            </div>

            {/* ERROR OVERLAY FOR HOST */}
            {revealError && isHost && (
                <div style={{
                    position: 'absolute', top: '80px', left: '50%', transform: 'translateX(-50%)',
                    background: 'rgba(233, 20, 41, 0.9)', color: 'white', padding: '12px 24px',
                    borderRadius: '12px', zIndex: 100, display: 'flex', alignItems: 'center', gap: '16px',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.5)'
                }}>
                    <div style={{ fontWeight: 700 }}>
                        Reveal Failed: {revealError}
                    </div>
                    <button
                        className="btn-primary"
                        style={{ padding: '6px 12px', fontSize: '0.8rem', height: 'auto' }}
                        onClick={() => processReveal()}
                    >
                        Retry
                    </button>
                </div>
            )}

            {/* Main Game Area */}
            <div className="game-stage animate-in" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', paddingTop: '10vh', paddingBottom: '20px', paddingLeft: '20px', paddingRight: '20px', position: 'relative', overflow: 'hidden' }}>
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
                                        const correct = p.last_round_correct_title === true || p.last_round_correct_artist === true
                                        return (

                                            <div key={p.id} style={{
                                                display: 'flex', alignItems: 'center', gap: '12px',
                                                padding: '8px 12px', borderRadius: '10px',
                                                background: correct ? 'rgba(30, 215, 96, 0.08)' : 'rgba(233, 20, 41, 0.08)',
                                                border: `1px solid ${correct ? 'rgba(30, 215, 96, 0.22)' : 'rgba(233, 20, 41, 0.22)'}`,
                                                cursor: 'pointer'
                                            }}
                                                onClick={(e) => openUserMenu(p, e)}
                                                onContextMenu={(e) => openUserMenu(p, e)}
                                            >
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
                {/* This line was misplaced and malformed. Assuming it was meant to be a comment or a variable definition elsewhere. */}
                {/* If 'updatedPlayers' is needed, define it in the component's logic, not directly in JSX like this. */}
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
                        const correctTitle = p.last_round_correct_title === true
                        const correctArtist = p.last_round_correct_artist === true
                        const isCorrect = correctTitle || correctArtist
                        resultClass = isCorrect ? 'correct' : 'wrong'
                    }

                    return (
                        <div
                            key={p.id}

                            className={`player-card ${isSubmitter ? 'submitted' : ''} ${resultClass} ${isMe ? 'me' : ''}`}
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => openUserMenu(p, e)}
                            onContextMenu={(e) => openUserMenu(p, e)}
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
                onError={handleAudioError}
            />

            <EmoteBar roomCode={code} />

            {
                selectedPlayer && (
                    <UserPopover
                        isOpen={!!selectedPlayer}
                        targetUser={selectedPlayer}
                        onClose={closeUserMenu}
                        currentUserProfileId={profile?.id}
                        anchorPoint={menuAnchor || undefined}
                    />
                )
            }
        </div >
    )
}
