'use client'

import { useEffect, useState, useRef, useMemo, type MouseEvent, type SyntheticEvent } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { db } from '@/lib/firebase'
import { ref, onValue, update, get, serverTimestamp, onDisconnect } from 'firebase/database'
import { useUser } from '@/context/UserContext'
import { GameState, SongItem } from '@/lib/game-logic'
import { useVolume } from '@/context/VolumeContext'

import { Music, Check, Mic2, Disc, FileText, Zap, SkipForward, HelpCircle, Mic } from 'lucide-react'
import ProgressBar from '@/components/ProgressBar'
import { soundManager } from '@/lib/sounds'
import { processNextRound } from '@/lib/game-round-manager'
import { useColor } from 'color-thief-react'
import EmoteBar from '@/components/EmoteBar'
import Onboarding from '@/components/Onboarding'
import GameRecap from '@/components/GameRecap'
import { initiateSuddenDeath, fetchMoreSuddenDeathSongs, endSuddenDeath } from '@/lib/sudden-death'
import UserPopover from '@/components/UserPopover'
import GuessWhoButton from '@/components/GuessWhoButton'
import { useIOSAudioUnlock } from '@/hooks/useIOSAudioUnlock'
import AnimatedNumber from '@/components/AnimatedNumber'

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
    last_round_index?: number
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
    const [audioStatus, setAudioStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle')
    const [audioLoadError, setAudioLoadError] = useState<boolean>(false)
    const [retryTrigger, setRetryTrigger] = useState(0) // Retry counter for failed audio
    const [isBulletRound, setIsBulletRound] = useState(false)
    const [playingSongId, setPlayingSongId] = useState<string | null>(null) // Track which song is ACTUALLY playing
    const [scoreDeltas, setScoreDeltas] = useState<Record<string, number>>({})
    const [rankChanges, setRankChanges] = useState<Record<string, number>>({})
    const [roomSongs, setRoomSongs] = useState<{ track_name: string, artist_name: string }[]>([])
    const [artistFocused, setArtistFocused] = useState(false)
    const [whoSangThatData, setWhoSangThatData] = useState<{
        excerpt: string[]
        options: { name: string, photo: string | null }[]
    } | null>(null)

    const { volume } = useVolume()
    const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null)
    const [menuAnchor, setMenuAnchor] = useState<{ x: number, y: number } | null>(null)

    // Derived State Needed for useColor at top-level
    const currentSongTemp = gameState?.playlist[gameState?.current_round_index || 0]
    const isLyricsOnlyTemp = roomSettings?.mode === 'lyrics_only'
    const isWhoSangThatTemp = roomSettings?.mode === 'who_sang_that'
    const isRealRevealTemp = gameState?.phase === 'reveal'
    const isAudioStaleTemp = audioStatus === 'playing' && playingSongId !== currentSongTemp?.id
    const isWaitingForAudioTemp = !isLyricsOnlyTemp && !isWhoSangThatTemp && gameState?.phase === 'playing' && (audioStatus === 'loading' || audioStatus === 'idle' || audioStatus === 'error' || audioLoadError || isAudioStaleTemp || !gameState.round_start_time)
    const previousSongTemp = (gameState?.current_round_index || 0) > 0 ? gameState?.playlist[(gameState?.current_round_index || 0) - 1] : null
    const effectiveSongTemp = (isWaitingForAudioTemp && previousSongTemp) ? previousSongTemp : currentSongTemp

    // --------------------------------------------------------------------------------
    // COLOR EXTRACTION (Dynamic Backgrounds) - MUST BE BEFORE EARLY RETURNS
    // --------------------------------------------------------------------------------
    const { data: dominantColor } = useColor(
        effectiveSongTemp?.cover_url || '/placeholder-cover.jpg',
        'rgbString',
        { crossOrigin: 'anonymous', quality: 10 }
    )

    const titleGradient = (() => {
        if (!dominantColor) return 'linear-gradient(135deg, #ffffff 0%, rgba(29, 185, 84, 0.8) 100%)'
        const match = dominantColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
        if (!match) return 'linear-gradient(135deg, #ffffff 0%, rgba(29, 185, 84, 0.8) 100%)'
        const r = parseInt(match[1]), g = parseInt(match[2]), b = parseInt(match[3])
        // Perceived brightness (0–1)
        const brightness = (r * 299 + g * 587 + b * 114) / 1000 / 255
        let r2, g2, b2
        if (brightness > 0.5) {
            // Bright primary — subtle darkening
            r2 = Math.round(r * 0.65); g2 = Math.round(g * 0.65); b2 = Math.round(b * 0.65)
        } else {
            // Dark primary — subtle lightening
            r2 = Math.round(r + (255 - r) * 0.28); g2 = Math.round(g + (255 - g) * 0.28); b2 = Math.round(b + (255 - b) * 0.28)
        }
        return `linear-gradient(135deg, rgb(${r},${g},${b}) 0%, rgb(${r2},${g2},${b2}) 100%)`
    })()

    // Only apply the dynamic color during the REVEAL phase. Otherwise, fallback to Spotify Green/Theme default.
    const dynamicFlare1Temp = isRealRevealTemp || (gameState?.phase === 'reveal')
        ? (dominantColor ? dominantColor.replace('rgb', 'rgba').replace(')', ', 0.6)') : 'rgba(29, 185, 84, 0.6)')
        : 'rgba(46, 242, 160, 0.5)'

    const dynamicFlare2Temp = isRealRevealTemp || (gameState?.phase === 'reveal')
        ? (dominantColor ? dominantColor.replace('rgb', 'rgba').replace(')', ', 0.4)') : 'rgba(30, 215, 96, 0.4)')
        : 'rgba(29, 185, 84, 0.4)'

    const dynamicFlare3Temp = isRealRevealTemp || (gameState?.phase === 'reveal')
        ? (dominantColor ? dominantColor.replace('rgb', 'rgba').replace(')', ', 0.3)') : 'rgba(29, 185, 84, 0.3)')
        : 'rgba(16, 133, 59, 0.3)'

    useEffect(() => {
        document.documentElement.style.setProperty('--flare-1', dynamicFlare1Temp)
        document.documentElement.style.setProperty('--flare-2', dynamicFlare2Temp)
        document.documentElement.style.setProperty('--flare-3', dynamicFlare3Temp)
    }, [dynamicFlare1Temp, dynamicFlare2Temp, dynamicFlare3Temp])

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
        const song = currentSongRef.current // Use ref to avoid stale closure
        if (!song) return

        const trackId = song.spotify_uri
        if (!trackId) return

        setIsPlaying(false)

        const key = song.id || trackId
        const songId = song.id
        const lastErrorAt = audioErrorRef.current[key] || 0
        if (Date.now() - lastErrorAt < 10000) {
            return
        }
        audioErrorRef.current[key] = Date.now()

        resolvePreviewForSong(song)
            .then((newUrl) => {
                if (!newUrl || !audioRef.current) return
                if (currentSongRef.current?.id !== songId) return // Song changed, discard
                audioRef.current.src = newUrl
                lastAudioSrcRef.current = newUrl
                audioRef.current.load()
                audioRef.current.play()
                    .then(() => {
                        if (currentSongRef.current?.id !== songId) return
                        setIsPlaying(true)
                    })
                    .catch(err => console.error('[Audio] Play failed after error refresh:', err))
            })
            .catch(err => {
                console.error('[Audio] Refresh after error failed:', err)
            })
    }

    // Refs
    const audioRef = useRef<HTMLAudioElement | null>(null)

    // iOS WebKit blocks audio until a user gesture fires. Unlock on first touch.
    useIOSAudioUnlock(audioRef)
    const audioRetryRef = useRef<Record<string, number>>({})
    const lastRevealSoundRoundRef = useRef<number | null>(null)
    const playersRef = useRef<Player[]>([]) // Authoritative ref to avoid stale closures
    const gameStateRef = useRef<GameState | null>(null)
    const hasScheduledNextRoundRef = useRef(false)
    const sdTopUpRoundRef = useRef<number | null>(null)
    const latestGuessRef = useRef({ artist: '', title: '' }) // Latest text input
    const hasSubmittedRef = useRef(false) // Ref for sync logic to avoid stale closure
    const roomSettingsRef = useRef<any>(null)
    const titleInputRef = useRef<HTMLInputElement | null>(null)
    const artistInputRef = useRef<HTMLInputElement | null>(null)
    const lyricsCacheRef = useRef<Record<string, string | null>>({})
    const processingRoundRef = useRef<number | null>(null) // Prevention for double-execution
    const lastAudioSrcRef = useRef<string | null>(null)
    const audioPreviewOverrideRef = useRef<Record<string, string>>({})
    const audioErrorRef = useRef<Record<string, number>>({})
    const audioPrefetchRef = useRef<Record<string, number>>({})
    const audioPrefetchInFlightRef = useRef<Record<string, boolean>>({})
    const audioPrefetchPromisesRef = useRef<Record<string, Promise<string | null> | null>>({})
    const prevScoresRef = useRef<Record<string, number>>({})
    const prevRanksRef = useRef<Record<string, number>>({})
    const currentSongRef = useRef<SongItem | undefined>(undefined)
    const whoSangThatHydrationRef = useRef<Record<string, boolean>>({})

    // Load room songs once for autocomplete
    useEffect(() => {
        if (!code) return
        get(ref(db, `rooms/${code}/songs`)).then(snap => {
            if (!snap.exists()) return
            const songs = Object.values(snap.val()) as any[]
            setRoomSongs(songs.map(s => ({ track_name: s.track_name || '', artist_name: s.artist_name || '' })))
        }).catch(() => { })
    }, [code])

    const artistSuggestions = useMemo(() => {
        if (!guess.artist || guess.artist.length < 2) return []
        const q = guess.artist.toLowerCase()
        return [...new Set(
            roomSongs.filter(s => s.artist_name.toLowerCase().includes(q)).map(s => s.artist_name)
        )].slice(0, 5)
    }, [guess.artist, roomSongs])

    const resolvePreviewForSong = async (song: SongItem): Promise<string | null> => {
        if (!song) return null
        const cached = audioPreviewOverrideRef.current[song.id]
        if (cached) return cached

        const trackId = song.spotify_uri
        const isDeezerId = typeof trackId === 'string' && /^\d+$/.test(trackId)
        const isMasked = song.artist_name === '???' || song.track_name === '???'

        const tryRefreshById = async (): Promise<string | null> => {
            if (!isDeezerId) return null
            try {
                const res = await fetch(`/api/refresh-track?id=${trackId}`)
                const data = await res.json()
                if (data.preview_url) return data.preview_url.replace(/^http:\/\//i, 'https://')
            } catch (err) {
                console.error('[Audio] ID refresh failed:', err)
            }
            return null
        }

        const tryResolveByMeta = async (): Promise<string | null> => {
            if (isMasked || !song.artist_name || !song.track_name) return null
            try {
                const res = await fetch('/api/resolve-tracks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tracks: [{ artist: song.artist_name, title: song.track_name }] })
                })
                const data = await res.json()
                const resolved = data?.tracks?.find((t: any) => t?.resolved && t?.deezer?.preview_url)
                if (resolved?.deezer?.preview_url) return resolved.deezer.preview_url.replace(/^http:\/\//i, 'https://')
            } catch (err) {
                console.error('[Audio] Meta resolution failed:', err)
            }
            return null
        }

        // Fire both strategies simultaneously — use whichever returns a URL first
        const [fromId, fromMeta] = await Promise.all([tryRefreshById(), tryResolveByMeta()])
        const newUrl = fromId || fromMeta

        if (newUrl && song.id) {
            audioPreviewOverrideRef.current[song.id] = newUrl
        }
        return newUrl || null
    }

    const isPreviewExpired = (url: string, nowSeconds: number, leewaySeconds = 0) => {
        const matchExp = url.match(/exp=(\d+)/)
        const expTime = matchExp ? parseInt(matchExp[1]) : 0
        return expTime > 0 && expTime < nowSeconds + leewaySeconds
    }

    const getPreviewStatus = (song: SongItem) => {
        const previewUrl = typeof song.preview_url === 'string' ? song.preview_url.trim() : ''
        const normalizedPreview = previewUrl.replace(/^http:\/\//i, 'https://')
        const overridePreview = song.id ? audioPreviewOverrideRef.current[song.id] : null
        const previewToUse = overridePreview || normalizedPreview
        const hasValidPreview = previewToUse.length > 0 && previewToUse.startsWith('http')
        const nowSeconds = Math.floor(Date.now() / 1000)
        const isExpiredSoon = hasValidPreview && isPreviewExpired(previewToUse, nowSeconds, 60)
        return { previewToUse, hasValidPreview, isExpiredSoon }
    }

    const prefetchSongPreview = (song: SongItem, force: boolean = false): Promise<string | null> => {
        const { previewToUse, hasValidPreview, isExpiredSoon } = getPreviewStatus(song)
        if (hasValidPreview && !isExpiredSoon) return Promise.resolve(previewToUse || null)

        const prefetchKey = song.id || song.spotify_uri || previewToUse
        if (!prefetchKey) return Promise.resolve(null)

        const existing = audioPrefetchPromisesRef.current[prefetchKey]
        if (existing) return existing

        const lastPrefetchAt = audioPrefetchRef.current[prefetchKey] || 0
        if (!force && Date.now() - lastPrefetchAt < 10000) return Promise.resolve(null)

        if (audioPrefetchInFlightRef.current[prefetchKey]) {
            return audioPrefetchPromisesRef.current[prefetchKey] || Promise.resolve(null)
        }

        audioPrefetchInFlightRef.current[prefetchKey] = true
        audioPrefetchRef.current[prefetchKey] = Date.now()

        const p = resolvePreviewForSong(song)
            .then((newUrl) => {
                if (newUrl && song.id) {
                    audioPreviewOverrideRef.current[song.id] = newUrl
                }
                return newUrl || null
            })
            .catch((e) => {
                console.error('[Audio] Prefetch failed:', e)
                return null
            })
            .finally(() => {
                audioPrefetchInFlightRef.current[prefetchKey] = false
                audioPrefetchPromisesRef.current[prefetchKey] = null
            })

        audioPrefetchPromisesRef.current[prefetchKey] = p
        return p
    }

    const waitMs = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

    const probePreviewPlayable = (url: string, timeoutMs = 10000): Promise<boolean> => {
        return new Promise((resolve) => {
            if (!url) {
                resolve(false)
                return
            }

            let settled = false
            const audio = new Audio()
            audio.preload = 'auto'
            audio.muted = true

            const done = (ok: boolean) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                audio.removeEventListener('canplay', onReady)
                audio.removeEventListener('loadedmetadata', onReady)
                audio.removeEventListener('error', onError)
                try {
                    audio.pause()
                    audio.src = ''
                    audio.load()
                } catch {
                    // No-op cleanup.
                }
                resolve(ok)
            }

            const onReady = () => done(true)
            const onError = () => done(false)

            const timer = setTimeout(() => done(false), timeoutMs)

            audio.addEventListener('canplay', onReady, { once: true })
            audio.addEventListener('loadedmetadata', onReady, { once: true })
            audio.addEventListener('error', onError, { once: true })
            audio.src = url
            audio.load()
        })
    }

    const ensureRoundAudioReady = async (roomCode: string, roundIndex: number): Promise<boolean> => {
        const retryDelayMs = 5000

        while (true) {
            const liveState = gameStateRef.current
            if (!liveState || liveState.phase !== 'reveal') return false

            const liveSong = liveState.playlist?.[roundIndex]
            if (!liveSong) return false

            const status = getPreviewStatus(liveSong)
            if (status.hasValidPreview && !status.isExpiredSoon) {
                const playable = await probePreviewPlayable(status.previewToUse, 12000)
                if (playable) return true
            }

            const prefetched = await prefetchSongPreview(liveSong, true)
            if (prefetched) {
                const playable = await probePreviewPlayable(prefetched, 12000)
                if (playable) return true
            }

            try {
                const repairRes = await fetch('/api/game/replace-song', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ roomCode, roundIndex })
                })
                const repairData = await repairRes.json().catch(() => ({}))
                if (!repairRes.ok) {
                    console.warn(`[Audio Gate] Repair failed (${repairRes.status}): ${repairData?.error || 'unknown'}`)
                } else {
                    // Give Firebase listeners a moment to receive updated preview/song data.
                    await waitMs(1000)
                    const refreshed = gameStateRef.current?.playlist?.[roundIndex]
                    if (refreshed) {
                        const refreshedStatus = getPreviewStatus(refreshed)
                        if (refreshedStatus.hasValidPreview && !refreshedStatus.isExpiredSoon) {
                            const playable = await probePreviewPlayable(refreshedStatus.previewToUse, 12000)
                            if (playable) return true
                        }
                    }
                }
            } catch (e) {
                console.warn('[Audio Gate] Repair request failed:', e)
            }

            await waitMs(retryDelayMs)
        }
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
    currentSongRef.current = currentSong
    const mode = roomSettings?.mode || 'normal'
    const isLyricsOnly = mode === 'lyrics_only'
    const isArtistOnly = mode === 'artist_only'
    const isSongOnly = mode === 'song_only'
    const isGuessWho = mode === 'guess_who'
    const isWhoSangThat = mode === 'who_sang_that'
    const showTitleInput = mode !== 'artist_only' && !isGuessWho && !isWhoSangThat
    const showArtistInput = mode !== 'song_only' && !isGuessWho && !isWhoSangThat
    const duelingIds = gameState?.dueling_player_ids || []
    const isSuddenDeath = !!gameState?.is_sudden_death
    const isDuelingPlayer = !isSuddenDeath || duelingIds.length === 0 || duelingIds.includes(profile.id)
    const canGuess = gameState?.phase === 'playing' && isDuelingPlayer
    const songPicker = currentSong ? players.find(p => p.id === currentSong.picked_by_user_id) : null
    const isMySong = songPicker?.id === profile.id

    // Guess Who pyramid grid layout helper
    const getGuessWhoRows = (ps: typeof players): (typeof players)[] => {
        const n = ps.length
        if (n <= 3) return [ps]
        if (n === 4) return [ps.slice(0, 2), ps.slice(2)]
        if (n === 5) return [ps.slice(0, 3), ps.slice(3)]
        if (n === 6) return [ps.slice(0, 3), ps.slice(3)]
        if (n === 7) return [ps.slice(0, 4), ps.slice(4)]
        if (n === 8) return [ps.slice(0, 4), ps.slice(4)]
        if (n === 9) return [ps.slice(0, 3), ps.slice(3, 6), ps.slice(6)]
        // 10+: rows of 4
        const rows: (typeof players)[] = []
        for (let i = 0; i < n; i += 4) rows.push(ps.slice(i, i + 4))
        return rows
    }

    // --------------------------------------------------------------------------------
    // 1. SYNC (The Heartbeat)
    // --------------------------------------------------------------------------------
    useEffect(() => {
        const roomRef = ref(db, `rooms/${code}`)

        // One-time room existence check (avoid reacting to every child write like reactions)
        get(roomRef).then((snapshot) => {
            if (!snapshot.exists()) {
                router.push('/')
            }
        })

        const settingsRef = ref(db, `rooms/${code}/settings`)
        const playersRefDb = ref(db, `rooms/${code}/players`)
        const gameStateRefDb = ref(db, `rooms/${code}/game_state`)
        const statusRef = ref(db, `rooms/${code}/status`)

        const unsubscribeSettings = onValue(settingsRef, (snapshot) => {
            if (!snapshot.exists()) return
            const settings = snapshot.val()
            roomSettingsRef.current = settings
            setRoomSettings(settings)
        })

        const unsubscribePlayers = onValue(playersRefDb, (snapshot) => {
            if (!snapshot.exists()) {
                setPlayers([])
                return
            }

            const pList = Object.values(snapshot.val()) as Player[]
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
        })

        const unsubscribeGameState = onValue(gameStateRefDb, (snapshot) => {
            if (!snapshot.exists()) return
            const serverState = snapshot.val()
            setGameState(serverState)

            // Timer Sync
            if (serverState.phase === 'playing' && serverState.round_start_time) {
                const startRaw = serverState.round_start_time
                const startMs = typeof startRaw === 'number'
                    ? startRaw
                    : new Date(startRaw).getTime()

                const totalTime = roomSettingsRef.current?.time || 15

                if (!Number.isNaN(startMs)) {
                    const now = Date.now() + serverTimeOffset
                    const elapsed = (now - startMs) / 1000
                    const remaining = Math.max(0, totalTime - elapsed) // FLOAT for smooth bar

                    const forceRaw = serverState.force_reveal_at
                    if (forceRaw) {
                        const forceMs = typeof forceRaw === 'number'
                            ? forceRaw
                            : new Date(forceRaw).getTime()
                        const forceRemaining = Math.max(0, (forceMs - now) / 1000)
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
        })

        const unsubscribeStatus = onValue(statusRef, (snapshot) => {
            if (!snapshot.exists()) return
            setStatus(snapshot.val())
        })

        return () => {
            unsubscribeSettings()
            unsubscribePlayers()
            unsubscribeGameState()
            unsubscribeStatus()
        }
    }, [code, router, profile.id, serverTimeOffset])

    // Track hasSubmitted in ref to avoid stale closure in listener
    useEffect(() => {
        hasSubmittedRef.current = hasSubmitted
    }, [hasSubmitted])

    // Reconnect protection: keep player slot during game
    useEffect(() => {
        if (!profile) return

        // Save active game to localStorage so MainMenu can offer a rejoin prompt
        localStorage.setItem('bb_active_game', JSON.stringify({ code, joinedAt: Date.now() }))

        const playerRef = ref(db, `rooms/${code}/players/${profile.id}`)
        onDisconnect(playerRef).cancel()

        // Re-add player if their slot was dropped by a previous onDisconnect
        get(playerRef).then(async (snap) => {
            if (snap.exists()) return
            // Reconstruct score from round_history
            let restoredScore = 0
            try {
                const historySnap = await get(ref(db, `rooms/${code}/round_history`))
                if (historySnap.exists()) {
                    const history = Object.values(historySnap.val()) as any[]
                    restoredScore = history.reduce((sum, round) => {
                        const guess = (round.guesses || []).find((g: any) => g.user_id === profile.id)
                        return sum + (guess?.points ?? 0)
                    }, 0)
                }
            } catch { /* non-fatal */ }

            update(playerRef, {
                id: profile.id,
                username: profile.username,
                avatar_url: profile.avatar_url,
                score: restoredScore,
                is_host: false,
                is_ready: true,
                has_submitted: false,
                joined_at: Date.now()
            })
        })
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
                last_round_correct_artist: undefined,
                last_round_correct_title: undefined,
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

    // Who Sang That: fetch options for current song
    useEffect(() => {
        const isWhoSangThatMode = roomSettings?.mode === 'who_sang_that'
        if (!isWhoSangThatMode || !currentSong?.id) {
            setWhoSangThatData(null)
            return
        }
        const extrasRef = ref(db, `rooms/${code}/who_sang_that_extras/${currentSong.id}`)
        const unsub = onValue(extrasRef, (snap) => {
            setWhoSangThatData(snap.exists() ? snap.val() : null)
        })
        return () => unsub()
    }, [currentSong?.id, roomSettings?.mode, code])

    useEffect(() => {
        const isWhoSangThatMode = roomSettings?.mode === 'who_sang_that'
        const hasOptions = Array.isArray(whoSangThatData?.options) && whoSangThatData.options.length > 0

        if (!isHost || !isWhoSangThatMode || !currentSong?.id || gameState?.current_round_index === undefined || hasOptions) {
            return
        }

        if (whoSangThatHydrationRef.current[currentSong.id]) {
            return
        }

        whoSangThatHydrationRef.current[currentSong.id] = true

        void fetch('/api/game/who-sang-that-extras', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                roomCode: code,
                roundIndices: [gameState.current_round_index]
            })
        }).then(async (res) => {
            if (res.ok) return
            const data = await res.json().catch(() => ({}))
            delete whoSangThatHydrationRef.current[currentSong.id]
            console.warn(`[WhoSangThat] Extras hydrate failed (${res.status}): ${data?.error || 'unknown'}`)
        }).catch((e) => {
            delete whoSangThatHydrationRef.current[currentSong.id]
            console.warn('[WhoSangThat] Extras hydrate request failed', e)
        })
    }, [isHost, roomSettings?.mode, currentSong?.id, gameState?.current_round_index, whoSangThatData?.options?.length, code])

    // --------------------------------------------------------------------------------
    // 3. COLOR EXTRACTION (Dynamic Backgrounds)
    // --------------------------------------------------------------------------------
    // Moved to section 5 (Render) to avoid "used before declaration" on effectiveSong.

    // Helper to get the correct icon for the placeholder vinyl
    const ModeIcon = () => {
        if (isArtistOnly) return <Mic2 size={48} className="glow-icon" />
        if (isSongOnly) return <Disc size={48} className="glow-icon" />
        if (isLyricsOnly) return <FileText size={48} className="glow-icon" />
        if (isGuessWho) return <HelpCircle size={48} className="glow-icon" />
        if (isWhoSangThat) return <Mic size={48} className="glow-icon" />
        if (gameState?.is_sudden_death) return <Zap size={48} color="#FFD700" className="glow-icon" />
        return <Music size={48} className="glow-icon" />
    }

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
    // Prefetch next round audio during reveal to avoid expired tokens at round start
    useEffect(() => {
        if (!gameState || gameState.phase !== 'reveal') return
        const nextSong = gameState.playlist?.[gameState.current_round_index + 1]
        if (!nextSong) return

        prefetchSongPreview(nextSong)
    }, [gameState?.phase, gameState?.current_round_index, gameState?.playlist?.length])

    useEffect(() => {
        if (!gameState || !currentSong) return

        const isLyricsOnly = roomSettings?.mode === 'lyrics_only'
        const isWhoSangThatMode = roomSettings?.mode === 'who_sang_that'
        const shouldPlayAudio = gameState.phase === 'reveal' || (!isLyricsOnly && !isWhoSangThatMode && gameState.phase === 'playing')
        const previewUrl = typeof currentSong.preview_url === 'string' ? currentSong.preview_url.trim() : ''
        const normalizedPreview = previewUrl.replace(/^http:\/\//i, 'https://')
        const overridePreview = currentSong?.id ? audioPreviewOverrideRef.current[currentSong.id] : null
        const previewToUse = overridePreview || normalizedPreview
        const hasValidPreview = previewToUse.length > 0 && previewToUse.startsWith('http')
        const retryKey = currentSong.id || previewToUse
        const lastRetryAt = audioRetryRef.current[retryKey] || 0
        const canRetry = !lastRetryAt || (Date.now() - lastRetryAt) > 10000
        const nowSeconds = Math.floor(Date.now() / 1000)

        // Auto-Fetch: If currently no preview URL, try to resolve it immediately
        if (!hasValidPreview && currentSong?.id && !audioPrefetchInFlightRef.current[currentSong.id]) {
            const lastAttempt = audioErrorRef.current[currentSong.id] || 0
            if (Date.now() - lastAttempt > 5000) {
                console.log('[Audio] Missing preview URL, attempting immediate resolution...')
                audioErrorRef.current[currentSong.id] = Date.now() // Prevent spam
                resolvePreviewForSong(currentSong).then(url => {
                    if (url) {
                        console.log('[Audio] Resolved missing preview:', url)
                        setRetryTrigger(n => n + 1) // Trigger re-render/play
                    }
                })
            }
        }

        const expectedSongId = currentSong.id // Capture for stale-closure guards

        const playUrl = (url: string) => {
            if (!audioRef.current) return
            if (currentSongRef.current?.id !== expectedSongId) return // Song changed, bail
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
                            if (currentSongRef.current?.id !== expectedSongId) return
                            setIsPlaying(true)
                            setAudioStatus('playing')
                            setPlayingSongId(expectedSongId)
                            setAudioLoadError(false)
                        })
                        .catch((err) => {
                            if (currentSongRef.current?.id !== expectedSongId) return
                            console.error('[Audio] Playback failed:', err)
                            setIsPlaying(false)
                            setAudioStatus('error')
                            setAudioLoadError(true)
                            const msg = typeof err?.message === 'string' ? err.message : ''
                            const isNotSupported = err?.name === 'NotSupportedError' || msg.includes('no supported source')
                            if (isNotSupported) {
                                const key = expectedSongId || url
                                const lastErr = audioErrorRef.current[key] || 0
                                if (Date.now() - lastErr > 10000) {
                                    audioErrorRef.current[key] = Date.now()
                                    resolvePreviewForSong(currentSong)
                                        .then((newUrl) => {
                                            if (!newUrl || !audioRef.current) return
                                            if (currentSongRef.current?.id !== expectedSongId) return
                                            audioRef.current.src = newUrl
                                            lastAudioSrcRef.current = newUrl
                                            audioRef.current.load()
                                            return audioRef.current.play()
                                                .then(() => {
                                                    if (currentSongRef.current?.id !== expectedSongId) return
                                                    setIsPlaying(true)
                                                    setAudioStatus('playing')
                                                    setPlayingSongId(expectedSongId)
                                                    setAudioLoadError(false)
                                                })
                                                .catch(e => {
                                                    console.error('[Audio] Playback failed after resolve:', e)
                                                    if (currentSongRef.current?.id !== expectedSongId) return
                                                    setAudioStatus('error')
                                                    setAudioLoadError(true)
                                                })
                                        })
                                        .catch(e => console.error('[Audio] Resolve after NotSupported failed:', e))
                                }
                            }
                        })
                }
            }
        }

        if (shouldPlayAudio) {
            if (audioStatus === 'idle' || audioStatus === 'error') {
                setAudioStatus('loading')
                setAudioLoadError(false)
            }
            // Lyrics/Who Sang That mode: only reveal audio, and avoid expired Spotify previews
            if ((isLyricsOnly || isWhoSangThatMode) && gameState.phase === 'reveal') {
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

            const isExpired = expTime > 0 && expTime < nowSeconds
            const isExpiringSoon = expTime > 0 && expTime < nowSeconds + 60

            // 1. If TOTALLY expired, we MUST refresh and cannot play yet
            if (isExpired) {
                if (canRetry) {
                    console.log('[Audio] Token expired, refreshing...', retryKey)
                    audioRetryRef.current[retryKey] = Date.now()
                    resolvePreviewForSong(currentSong)
                        .then((newUrl) => {
                            if (currentSongRef.current?.id !== expectedSongId) return // Song changed
                            if (newUrl) {
                                playUrl(newUrl)
                            } else {
                                console.error('[Audio] Refresh failed: No URL returned. Stopping playback.')
                                // STOP playback to prevent old song from looping
                                if (audioRef.current) {
                                    audioRef.current.pause()
                                    audioRef.current.src = '' // Clear source
                                }
                                setIsPlaying(false)
                                setAudioStatus('error')
                            }
                        })
                        .catch(e => {
                            console.error('[Audio] Refresh Error:', e)
                            if (currentSongRef.current?.id !== expectedSongId) return
                            if (audioRef.current) {
                                audioRef.current.pause()
                            }
                            setIsPlaying(false)
                        })
                    return
                } else {
                    console.warn('[Audio] Token expired and already retried. Skipping playback.')
                    return // Give up
                }
            }

            // 2. If just "expiring soon", trigger refresh in background BUT play current url anyway
            if (isExpiringSoon && canRetry) {
                console.log('[Audio] Token expiring soon, refreshing in background...', retryKey)
                audioRetryRef.current[retryKey] = Date.now()
                resolvePreviewForSong(currentSong)
                    .then((newUrl) => {
                        // If we get a new URL, we update the override so NEXT time we use it
                        // We do NOT forcibly stop/restart the current audio because seamless playback is better
                        // But if the current one fails, the error handler will pick up this new override
                        if (newUrl) {
                            console.log('[Audio] Background refresh success')
                        }
                    })
                    .catch(e => console.error('[Audio] Background Refresh Error:', e))
                // FALL THROUGH to playUrl below!
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
    }, [gameState?.phase, currentSong, roomSettings?.mode, retryTrigger])

    // Host auto-starts the timer once audio is playing
    useEffect(() => {
        if (!isHost || gameState?.phase !== 'playing') return
        if (gameState?.round_start_time) return // Already started

        // If lyrics only or who_sang_that mode, there is no audio to wait for, so start immediately
        if (roomSettings?.mode === 'lyrics_only' || roomSettings?.mode === 'who_sang_that') {
            update(ref(db, `rooms/${code}/game_state`), {
                round_start_time: serverTimestamp() as any
            })
            return
        }

        // Normal mode: wait for audio to be playing AND no errors
        if (audioStatus === 'playing' && playingSongId === currentSong?.id) {
            console.log('[Audio Sync] Host audio is playing, starting round timer...')
            update(ref(db, `rooms/${code}/game_state`), {
                round_start_time: serverTimestamp() as any
            })
        }
    }, [isHost, gameState?.phase, gameState?.round_start_time, audioStatus, playingSongId, currentSong?.id, roomSettings?.mode, code])

    // Reset status on new song
    useEffect(() => {
        setAudioStatus('idle')
        setAudioLoadError(false)
        setIsBulletRound(false)
    }, [currentSong?.id])

    // Auto-Retry Loop for Audio Error
    useEffect(() => {
        if (gameState?.phase === 'playing' && (audioStatus === 'error' || audioLoadError)) {
            const t = setTimeout(() => {
                console.log('[Audio] Auto-retrying playback...')
                setAudioStatus('idle') // Reset to idle to trigger main effect
                setAudioLoadError(false)
                setRetryTrigger(n => n + 1)

                // Clear the "already retried" flag for this song so it actually tries again
                if (currentSong?.id) {
                    delete audioRetryRef.current[currentSong.id]
                    if (currentSong.preview_url) {
                        delete audioRetryRef.current[currentSong.preview_url]
                        // Also clear normalized version just in case
                        const norm = currentSong.preview_url.replace(/^http:\/\//i, 'https://')
                        delete audioRetryRef.current[norm]
                    }
                }
            }, 2000) // Retry every 2 seconds
            return () => clearTimeout(t)
        }
    }, [gameState?.phase, audioStatus, audioLoadError, currentSong?.id])

    useEffect(() => {
        if (gameState?.phase !== 'reveal') return
        if (lastRevealSoundRoundRef.current === gameState.current_round_index) return

        const me = players.find(p => p.id === profile.id)
        if (!me) return

        // Wait for results to propagate from Firebase
        // FIX: Ensure the player stats update corresponds to the CURRENT round
        if (me.last_round_index !== gameState.current_round_index) {
            console.log('[SFX] Waiting for fresh stats...', { local: me.last_round_index, server: gameState.current_round_index })
            return
        }

        const isTitleCorrect = !!me.last_round_correct_title
        const isArtistCorrect = !!me.last_round_correct_artist
        const correct = isTitleCorrect || isArtistCorrect

        console.log(`[SFX] Playing sound. Title: ${isTitleCorrect}, Artist: ${isArtistCorrect} -> ${correct ? 'correct' : 'wrong'}`)
        soundManager.play(correct ? 'correct' : 'wrong')
        lastRevealSoundRoundRef.current = gameState.current_round_index
    }, [gameState?.phase, gameState?.current_round_index, players, profile.id])

    // Snapshot scores/ranks at start of each round so we can show deltas on reveal
    useEffect(() => {
        if (gameState?.phase !== 'playing') return
        const scores: Record<string, number> = {}
        const ranks: Record<string, number> = {}
        const sorted = [...players].sort((a, b) => b.score - a.score)
        players.forEach(p => { scores[p.id] = p.score })
        sorted.forEach((p, i) => { ranks[p.id] = i })
        prevScoresRef.current = scores
        prevRanksRef.current = ranks
        setScoreDeltas({})
        setRankChanges({})
    }, [gameState?.phase]) // eslint-disable-line react-hooks/exhaustive-deps

    // Compute score deltas and rank changes when reveal data arrives
    useEffect(() => {
        if (gameState?.phase !== 'reveal') return
        const hasData = players.some(p => p.last_round_correct_title !== undefined)
        if (!hasData) return
        const deltas: Record<string, number> = {}
        const changes: Record<string, number> = {}
        const sorted = [...players].sort((a, b) => b.score - a.score)
        players.forEach(p => {
            const prev = prevScoresRef.current[p.id] ?? p.score
            const d = p.score - prev
            if (d > 0) deltas[p.id] = d
        })
        sorted.forEach((p, i) => {
            const prevRank = prevRanksRef.current[p.id] ?? i
            changes[p.id] = prevRank - i // positive = moved up
        })
        setScoreDeltas(deltas)
        setRankChanges(changes)
    }, [players, gameState?.phase])

    // Timer Countdown (Synced with Server Time + Skew)
    useEffect(() => {
        const totalTime = roomSettings?.time || 15

        if (gameState?.phase === 'playing') {
            if (!gameState.round_start_time) {
                // Waiting for Audio Sync before starting timer
                setTimeLeft(totalTime)
                return
            }

            const startRaw = gameState.round_start_time
            const getStartMs = () => typeof startRaw === 'number' ? startRaw : (startRaw ? new Date(startRaw).getTime() : NaN)
            const startMs = getStartMs()

            // Immediate update function
            const updateTimer = () => {
                if (Number.isNaN(startMs) || !startRaw) {
                    setTimeLeft(totalTime)
                    return totalTime
                }

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

            // Guard: timer must see a positive value before it can trigger force-reveal.
            // Prevents round-0 bug where elapsed time is calculated before audio loads.
            let everSawPositive = false
            const interval = setInterval(() => {
                const t = updateTimer()
                if (t > 0.5) everSawPositive = true
                if (t <= 0 && isHost && everSawPositive) {
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

    const AudioStatusIndicator = () => {
        if (!gameState || !currentSong) return null
        const isLyricsOnly = roomSettings?.mode === 'lyrics_only'
        const isWhoSangThatAudio = roomSettings?.mode === 'who_sang_that'
        // Only show during playing (hidden in reveal usually, unless we want to show it there too)
        // Actually, user complained about silence.

        // If playing/reveal phase and we expect audio:
        const expectingAudio = gameState.phase === 'reveal' || (!isLyricsOnly && !isWhoSangThatAudio && gameState.phase === 'playing')

        if (!expectingAudio) return null

        if (audioStatus === 'loading') {
            return (
                <div className="glass-panel" style={{
                    position: 'fixed', top: '80px', right: '20px',
                    padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px', zIndex: 100
                }}>
                    <div className="spinner" style={{ width: '16px', height: '16px', border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                    <span style={{ fontSize: '0.8rem' }}>Loading Audio...</span>
                    <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
                </div>
            )
        }

        if (audioStatus === 'error' || audioLoadError) {
            return (
                <div className="glass-panel" style={{
                    position: 'fixed', top: '80px', right: '20px',
                    padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px', zIndex: 100,
                    borderColor: '#ff4444', color: '#ff4444'
                }}>
                    <span style={{ fontSize: '0.8rem' }}>Audio Unavailable</span>
                </div>
            )
        }

        return null
    }

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
        if (gameState?.phase === 'playing' && gameState.round_start_time && timeLeft <= 0 && !hasSubmitted && isDuelingPlayer) {
            submitGuess()
        }
    }, [gameState?.phase, gameState?.round_start_time, timeLeft, hasSubmitted, isDuelingPlayer])

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
        if (!gameState?.round_start_time) return  // Round not started yet — ignore stale has_submitted

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
                const serverNow = Date.now() + serverTimeOffset
                update(ref(db, `rooms/${code}/game_state`), {
                    force_reveal_at: serverNow + 3000
                })
            } else if (timeLeft <= 0 && !revealError) {
                processReveal()
            }
        }
    }, [players, isHost, gameState?.phase, timeLeft, gameState?.force_reveal_at, gameState?.is_sudden_death, gameState?.dueling_player_ids, revealError, serverTimeOffset]) // Listen to players update

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

            const nextRoundIndex = currentGameState.current_round_index + 1
            const nextSong = currentGameState.playlist?.[nextRoundIndex]
            if (nextSong) {
                const ready = await ensureRoundAudioReady(code, nextRoundIndex)
                if (!ready) {
                    hasScheduledNextRoundRef.current = false
                    return
                }
            }

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

                    const nextRoundIndex = currentGameState.current_round_index + 1
                    const nextSong = currentGameState.playlist?.[nextRoundIndex]
                    if (nextSong) {
                        const ready = await ensureRoundAudioReady(code, nextRoundIndex)
                        if (!ready) {
                            hasScheduledNextRoundRef.current = false
                            return
                        }
                    }

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

    const flareIsAudioStale = audioStatus === 'playing' && playingSongId !== currentSongTemp?.id
    const flareIsWaitingForAudio = Boolean(
        gameState &&
        !isLyricsOnlyTemp &&
        !isWhoSangThatTemp &&
        gameState.phase === 'playing' &&
        (audioStatus === 'loading' || audioStatus === 'idle' || audioStatus === 'error' || audioLoadError || flareIsAudioStale || !gameState.round_start_time)
    )
    const flareIsGameStartWaiting = Boolean(flareIsWaitingForAudio && (
        gameState?.current_round_index === 0 ||
        (gameState?.is_sudden_death && gameState?.current_round_index === gameState?.sudden_death_start_index)
    ))
    const flareIsReveal = Boolean(gameState?.phase === 'reveal' || (flareIsWaitingForAudio && !flareIsGameStartWaiting))

    useEffect(() => {
        document.documentElement.style.setProperty('--flare-body-opacity', flareIsReveal ? '0.34' : '0.18')
        document.documentElement.style.setProperty('--flare-center-opacity', flareIsReveal ? '0.3' : '0.14')
        document.documentElement.style.setProperty('--flare-reveal-pulse-state', flareIsReveal ? 'running' : 'paused')
        document.documentElement.style.setProperty('--flare-drift-speed', flareIsReveal ? '30s' : '54s')

        return () => {
            document.documentElement.style.setProperty('--flare-body-opacity', '0.22')
            document.documentElement.style.setProperty('--flare-center-opacity', '0.18')
            document.documentElement.style.setProperty('--flare-reveal-pulse-state', 'paused')
            document.documentElement.style.setProperty('--flare-drift-speed', '54s')
        }
    }, [flareIsReveal])

    // A. Finished -> Podium
    if (status === 'finished') {
        localStorage.removeItem('bb_active_game')
        return <GameRecap roomCode={code} players={players} />
    }

    if (!gameState || !currentSong) return <div className="flex-center" style={{ height: '100dvh' }}>Loading Game...</div>

    // B. VS Screen (Sudden Death Intro)
    if (gameState.phase === 'vs_screen') {
        const duelingPlayers = players.filter(p =>
            gameState.dueling_player_ids?.includes(p.id)
        )

        return (
            <div className="sd-vs-screen">
                {/* Scanline overlay */}
                <div className="sd-scanlines" />

                {/* Title */}
                <div className="sd-title-wrap">
                    <div className="sd-sudden-label">SUDDEN DEATH</div>
                </div>

                {/* Players row */}
                <div className="sd-players-row">
                    {duelingPlayers.length === 2 ? (
                        <>
                            <div className="sd-fighter sd-fighter--left">
                                <div className="sd-fighter-avatar-wrap">
                                    <img src={duelingPlayers[0].avatar_url} alt={duelingPlayers[0].username} className="sd-fighter-avatar" />
                                </div>
                                <div className="sd-fighter-name">{duelingPlayers[0].username}</div>
                                <div className="sd-fighter-score">
                                    {duelingPlayers[0].sudden_death_score || 0}
                                    <span className="sd-fighter-score-label">SD PTS</span>
                                </div>
                            </div>

                            <div className="sd-vs-badge">VS</div>

                            <div className="sd-fighter sd-fighter--right">
                                <div className="sd-fighter-avatar-wrap">
                                    <img src={duelingPlayers[1].avatar_url} alt={duelingPlayers[1].username} className="sd-fighter-avatar" />
                                </div>
                                <div className="sd-fighter-name">{duelingPlayers[1].username}</div>
                                <div className="sd-fighter-score">
                                    {duelingPlayers[1].sudden_death_score || 0}
                                    <span className="sd-fighter-score-label">SD PTS</span>
                                </div>
                            </div>
                        </>
                    ) : (
                        duelingPlayers.map((p, idx) => (
                            <div
                                key={p.id}
                                className={`sd-fighter ${idx % 2 === 0 ? 'sd-fighter--left' : 'sd-fighter--right'}`}
                            >
                                <div className="sd-fighter-avatar-wrap">
                                    <img src={p.avatar_url} alt={p.username} className="sd-fighter-avatar" />
                                </div>
                                <div className="sd-fighter-name">{p.username}</div>
                                <div className="sd-fighter-score">
                                    {p.sudden_death_score || 0}
                                    <span className="sd-fighter-score-label">SD PTS</span>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Subtitle */}
                <div className="sd-subtitle">
                    {duelingPlayers.length === 2 ? 'HEAD TO HEAD' : 'MULTI-WAY TIE'} · FIRST TO BREAK WINS
                </div>

                {isLyricsOnly && (
                    <div className="sd-lyrics-loading">
                        <div className="animate-spin" style={{ width: '18px', height: '18px', border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', flexShrink: 0 }} />
                        LOADING LYRICS...
                    </div>
                )}
            </div>
        )
    }

    const isRealReveal = gameState.phase === 'reveal'

    // If we are "playing" but audio is still loading, look like we are in reveal of PREVIOUS round
    const isAudioStale = audioStatus === 'playing' && playingSongId !== currentSongTemp?.id
    const isWaitingForAudio = !isLyricsOnlyTemp && !isWhoSangThatTemp && gameState?.phase === 'playing' && (audioStatus === 'loading' || audioStatus === 'idle' || audioStatus === 'error' || audioLoadError || isAudioStale || !gameState.round_start_time)

    // Check if this is the very first moment of the game before round 1 actually starts playing
    const isGameStartWaiting = isWaitingForAudio && (
        gameState?.current_round_index === 0 ||
        (gameState?.is_sudden_death && gameState?.current_round_index === gameState?.sudden_death_start_index)
    )

    // Effective State for Render - Do NOT show reveal screen if the game is just starting (prevents Round 0 "Wrong Answer" flash)
    const isReveal = isRealReveal || (isWaitingForAudio && !isGameStartWaiting)

    // If waiting for audio, show PREVIOUS song, not current.
    const previousSong = gameState.current_round_index > 0 ? gameState.playlist[gameState.current_round_index - 1] : null
    const effectiveSong = (isWaitingForAudio && previousSong) ? previousSong : currentSong

    // Color variables derived at the top level are mapped here for inline style usage
    const dynamicFlare1 = dynamicFlare1Temp
    const dynamicFlare2 = dynamicFlare2Temp
    const dynamicFlare3 = dynamicFlare3Temp

    const displayRound = gameState.is_sudden_death ? (roomSettings?.rounds || (gameState.current_round_index + 1)) : (gameState.current_round_index + 1)
    const displayPlayers = (isSuddenDeath && duelingIds.length > 0)
        ? players.filter(p => duelingIds.includes(p.id))
        : players
    const isUrgentTimer = gameState.phase === 'playing' && !isWaitingForAudio && timeLeft > 0 && timeLeft <= 5
    const modeLabel = ({
        normal: 'Guess That Tune',
        rapid: 'Quickdraw',
        artist_only: 'Artist Only',
        song_only: 'Song Only',
        lyrics_only: 'Lyrics Mode',
        guess_who: 'Who Got The Aux?',
        who_sang_that: 'Who Sang That?',
    } as Record<string, string>)[mode] || 'BeatBattle'
    const sortedDisplayPlayers = [...displayPlayers].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return (b.sudden_death_score || 0) - (a.sudden_death_score || 0)
    })

    return (
        <div className={`game-shell ${isReveal ? 'phase-reveal' : 'phase-playing'}${isUrgentTimer ? ' time-urgent' : ''}${isWhoSangThat ? ' mode-who-sang-that' : ''}`} style={{ width: '100%', margin: '0 auto', paddingBottom: '28px', minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
            <style jsx>{`
                .vinyl-container {
                    width: 300px;
                    height: 300px;
                    border-radius: 50%;
                    position: relative;
                    background: linear-gradient(135deg, #111, #000);
                    box-shadow: 0 0 50px rgba(0, 0, 0, 0.8),
                        inset 0 0 15px rgba(255, 255, 255, 0.05),
                        inset 0 0 40px rgba(0, 0, 0, 0.9);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border: 1px solid rgba(255, 255, 255, 0.05);
                    backdrop-filter: blur(20px);
                }

                .vinyl-container.spinning {
                    animation: spin 3s linear infinite;
                }

                .vinyl-container.reveal {
                    border: none;
                    background: transparent;
                }

                .vinyl-grooves {
                    position: absolute;
                    top: 5%;
                    left: 5%;
                    width: 90%;
                    height: 90%;
                    border-radius: 50%;
                    border: 1px solid rgba(255, 255, 255, 0.03);
                    pointer-events: none;
                    background:
                        repeating-radial-gradient(circle at center,
                            transparent,
                            transparent 4px,
                            rgba(255, 255, 255, 0.05) 5px,
                            rgba(255, 255, 255, 0.02) 6px);
                    transition: opacity 0.4s ease;
                }

                .vinyl-container.reveal .vinyl-grooves {
                    opacity: 0;
                }

                .vinyl-container::after {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    border-radius: 50%;
                    background: linear-gradient(135deg, rgba(255, 255, 255, 0.15) 0%, transparent 40%, transparent 60%, rgba(255, 255, 255, 0.05) 100%);
                    pointer-events: none;
                    transition: opacity 0.4s ease;
                }

                .vinyl-container.reveal::after {
                    opacity: 0;
                }

                .vinyl-label {
                    width: 120px;
                    height: 120px;
                    border-radius: 50%;
                    background: rgba(255, 255, 255, 0.05);
                    backdrop-filter: blur(10px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    overflow: hidden;
                    border: 2px solid rgba(255, 255, 255, 0.1);
                    transition: width 0.6s ease, height 0.6s ease;
                }

                .vinyl-label.reveal {
                    width: 100%;
                    height: 100%;
                    border-radius: 50%;
                    border: none;
                }

                .vinyl-cover {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    opacity: 0;
                    animation: revealCover 0.6s forwards ease-out;
                    border-radius: 50%;
                }

                .glow-icon {
                    opacity: 0.8;
                    color: var(--primary);
                    filter: drop-shadow(0 0 10px rgba(30, 215, 96, 0.8));
                    animation: pulse-glow 2s infinite alternate ease-in-out;
                }

                @keyframes pulse-glow {
                    0% {
                        filter: drop-shadow(0 0 8px rgba(30, 215, 96, 0.5));
                        transform: scale(0.95);
                    }
                    100% {
                        filter: drop-shadow(0 0 20px rgba(30, 215, 96, 1));
                        transform: scale(1.05);
                    }
                }

                @keyframes revealCover {
                    0% {
                        opacity: 0;
                        filter: blur(10px) brightness(0.5);
                    }
                    100% {
                        opacity: 1;
                        filter: blur(0) brightness(1);
                    }
                }
            `}</style>
            {/* Top HUD */}
            <div className="game-hud">
                <div className="hud-bar">
                    <div className="hud-chip hud-chip--round">
                        <span className="hud-chip__eyebrow">Round</span>
                        <span className="hud-chip__value">{displayRound} / {roomSettings?.rounds}</span>
                        {gameState.is_sudden_death && <span className="round-tag">Sudden Death</span>}
                        {isBulletRound && <span className="round-tag" style={{ background: '#ff4444', color: 'white', borderColor: '#ff4444' }}>Bullet Round</span>}
                    </div>

                    <div className="hud-center">
                        <div className="hud-mode-pill">{modeLabel}</div>
                        <div className="hud-progress">
                            <ProgressBar current={timeSynced ? Math.max(0, timeLeft) : 0} total={roomSettings?.time || 15} />
                        </div>
                        <div className="hud-status-row">
                            {(showRevealLyricsFetch && isLyricsOnly && isRealReveal) && (
                                <div className="reveal-loading-pill hud-status-pill" style={{
                                    background: 'rgba(255, 215, 0, 0.2)', color: '#FFD700',
                                    border: '1px solid rgba(255, 215, 0, 0.4)'
                                }}>
                                    <div className="animate-spin" style={{ width: '12px', height: '12px', border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%' }} />
                                    Fetching new lyrics
                                </div>
                            )}

                            {isWaitingForAudio && (
                                <div className="reveal-loading-pill hud-status-pill" style={{
                                    background: 'rgba(30, 215, 96, 0.2)', color: '#1ed760',
                                    border: '1px solid rgba(30, 215, 96, 0.4)'
                                }}>
                                    <div className="animate-spin" style={{ width: '12px', height: '12px', border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%' }} />
                                    Loading next song
                                </div>
                            )}
                        </div>
                    </div>

                    <div className={`timer-pill ${gameState.phase === 'playing' && !isWaitingForAudio && timeLeft <= 3 ? 'countdown-pulse' : ''}`}>
                        {timeSynced ? Math.ceil(Math.max(0, timeLeft)) : '...'}
                    </div>
                </div>
            </div >

            {/* ERROR OVERLAY FOR HOST */}
            {
                revealError && isHost && (
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
                )
            }

            {/* Main Game Area */}
            <div className="game-stage animate-in" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', paddingTop: '4vh', paddingBottom: '20px', paddingLeft: '20px', paddingRight: '20px', position: 'relative', overflow: 'visible' }}>
                {/* Host skip button — invisible, hover to reveal */}
                {isHost && gameState?.phase === 'playing' && (
                    <button
                        onClick={() => processReveal()}
                        title="Skip Round"
                        className="host-skip-btn"
                    >
                        <SkipForward size={16} />
                    </button>
                )}
                <div className="game-core">
                    {/* Album Cover Area (Hidden until Reveal for lyrics/who-sang-that modes) */}
                    {((!isLyricsOnly && !isWhoSangThat) || isReveal) && (() => {
                        const myResult = players.find(p => p.id === profile?.id)
                        const hasResult = myResult?.last_round_correct_title !== undefined
                        const iGotCorrect = hasResult && (myResult?.last_round_correct_title === true || myResult?.last_round_correct_artist === true)
                        const glowBoxShadow = isReveal && hasResult
                            ? iGotCorrect
                                ? '0 0 0 2px rgba(29,185,84,0.5), 0 0 35px rgba(29,185,84,0.55), 0 0 70px rgba(29,185,84,0.22)'
                                : '0 0 0 2px rgba(248,113,113,0.5), 0 0 35px rgba(248,113,113,0.55), 0 0 70px rgba(248,113,113,0.22)'
                            : undefined
                        return (
                        <div
                            className={`vinyl-container ${isPlaying ? 'spinning' : ''} ${isReveal ? 'reveal reveal-pop' : ''}`}
                            style={{ marginBottom: '32px', transition: 'box-shadow 0.5s ease', boxShadow: glowBoxShadow }}
                        >
                            <div className="vinyl-grooves" />
                            <div className={`vinyl-label ${isReveal ? 'reveal' : ''}`}>
                                {isReveal ? (
                                    <img
                                        className="vinyl-cover"
                                        src={effectiveSong.cover_url || '/placeholder-cover.jpg'}
                                        onError={(e) => { e.currentTarget.src = '/placeholder-cover.jpg' }}
                                    />
                                ) : (
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>
                                        <ModeIcon />
                                    </div>
                                )}
                            </div>
                        </div>
                        )
                    })()}

                    {/* Question / Inputs */}
                    {isReveal ? (
                        <div style={{ textAlign: 'center', width: '100%' }}>
                            {effectiveSong.picked_by_user_id === profile.id && (
                                <div style={{ marginBottom: '12px', fontWeight: 700, color: '#FFD700' }}>
                                    This was your song
                                </div>
                            )}
                            <h2 className="text-gradient reveal-slide" style={{
                                fontSize: '2rem', fontWeight: 900, marginBottom: '8px', animationDelay: '0.1s',
                                '--title-gradient': titleGradient,
                                textShadow: dominantColor
                                    ? `0 0 20px ${dominantColor.replace('rgb', 'rgba').replace(')', ', 0.6)')}, 0 0 40px ${dominantColor.replace('rgb', 'rgba').replace(')', ', 0.3)')}`
                                    : '0 0 20px rgba(29, 185, 84, 0.5)',
                            } as React.CSSProperties}>
                                {effectiveSong.track_name}
                            </h2>
                            <h3 className="reveal-slide" style={{ fontSize: '1.5rem', color: '#ccc', animationDelay: '0.2s' }}>
                                {effectiveSong.artist_name}
                            </h3>
                            {/* We use 'songPicker' derived from currentSong mostly. Need to check if effectiveSong differs. */}
                            {isWhoSangThat ? (
                                // Who Sang That reveal: show both options, highlight the correct artist
                                <div style={{ marginTop: '16px' }}>
                                    <div style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                        The artist was...
                                    </div>
                                    {whoSangThatData?.options && (
                                        <div className="who-sang-that-options who-sang-that-options--reveal" style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                                            {whoSangThatData.options.map((opt, i) => {
                                                const isCorrect = opt.name.toLowerCase().trim() === effectiveSong.artist_name?.toLowerCase().trim()
                                                const myGuess = players.find(pl => pl.id === profile.id)?.last_guess?.title
                                                const iGuessedThis = myGuess?.toLowerCase().trim() === opt.name.toLowerCase().trim()
                                                const extraClass = isCorrect ? ' correct-answer' : (iGuessedThis && !isCorrect ? ' wrong-answer' : '')
                                                return (
                                                    <button key={i} className={`guess-who-btn${extraClass}`} disabled style={{ cursor: 'default', padding: '12px 10px', minWidth: '120px' }}>
                                                        <img src={opt.photo || '/placeholder-avatar.jpg'} alt={opt.name} className="guess-who-avatar" style={{ width: '80px', height: '80px' }} />
                                                        <span className="guess-who-name">{opt.name}</span>
                                                        {isCorrect && <span style={{ fontSize: '0.7rem', color: '#1ed760', marginTop: '-4px' }}>✓ correct</span>}
                                                    </button>
                                                )
                                            })}
                                        </div>
                                    )}
                                </div>
                            ) : isGuessWho ? (
                                // Guess Who reveal: show all players, highlight who actually added it
                                <div style={{ marginTop: '16px' }}>
                                    <div style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                        Who added this song?
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', width: '100%' }}>
                                        {getGuessWhoRows(players).map((row, rowIdx) => (
                                            <div key={rowIdx} style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                                                {row.map(p => {
                                                    const isCorrectPerson = p.id === effectiveSong.picked_by_user_id
                                                    const myGuess = players.find(pl => pl.id === profile.id)?.last_guess?.title
                                                    const iGuessedThis = myGuess === p.id
                                                    const extraClass = isCorrectPerson ? ' correct-answer' : (iGuessedThis && !isCorrectPerson ? ' wrong-answer' : '')
                                                    return (
                                                        <button key={p.id} className={`guess-who-btn${extraClass}`} disabled style={{ cursor: 'default', padding: '12px 10px' }}>
                                                            <img src={p.avatar_url} alt={p.username} className="guess-who-avatar" style={{ width: '44px', height: '44px' }} />
                                                            <span className="guess-who-name">{p.username}</span>
                                                            {isCorrectPerson && <span style={{ fontSize: '0.7rem', color: '#1ed760', marginTop: '-4px' }}>✓ correct</span>}
                                                        </button>
                                                    )
                                                })}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ) : (() => {
                                const picker = players.find(p => p.id === effectiveSong.picked_by_user_id)
                                const isMine = picker?.id === profile.id
                                if (picker && !isMine) {
                                    return (
                                        <div className="song-credit">
                                            <img src={picker.avatar_url} alt={picker.username} />
                                            <span>{picker.username} added this song</span>
                                        </div>
                                    )
                                }
                                return null
                            })()}


                            <div className="reveal-slide" style={{ marginTop: '18px', width: '100%', maxWidth: '520px', marginLeft: 'auto', marginRight: 'auto', animationDelay: '0.3s', textAlign: 'center' }}>
                                <div style={{ fontWeight: 700, marginBottom: '10px', opacity: 0.9 }}>Round Results</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {displayPlayers.map((p, i) => {
                                        // If viewing previous round (waiting for audio), we rely on 'last_' stats which ARE from previous round.
                                        // But if we advanced round index, 'last_' stats might have been reset?
                                        // In 'useEffect [gameState.current_round_index]', we reset stats:
                                        // setPlayers(prev => prev.map(p => ({ ...p, last_round_correct... = undefined })))
                                        // This means we CANNOT meaningfully show "Correct/Wrong" for the previous round once the round index has updated.
                                        // The stats are gone from local state.

                                        // However, showing the Reveal UI without stats is still better than showing the empty Game Input with no audio.
                                        // We can hide the specific "Correct/Wrong" pills if data is missing.

                                        const correct = p.last_round_correct_title === true || p.last_round_correct_artist === true
                                        const hasData = p.last_round_correct_title !== undefined

                                        // If we are waiting for audio, it's safer to just show the leaderboard or minimal info?
                                        // Actually, if we just transitioned, 'last_' stats in local state MIGHT be cleared.
                                        // Let's check the useEffect again.

                                        const delta = scoreDeltas[p.id]
                                        const rankChange = rankChanges[p.id] ?? 0

                                        return (
                                            <div key={p.id} className="reveal-slide" style={{
                                                display: 'flex', alignItems: 'center', gap: '12px',
                                                padding: '10px 14px', borderRadius: '10px',
                                                background: correct ? 'rgba(30, 215, 96, 0.08)' : 'rgba(233, 20, 41, 0.08)',
                                                border: `1px solid ${correct ? 'rgba(30, 215, 96, 0.22)' : 'rgba(233, 20, 41, 0.22)'}`,
                                                cursor: 'pointer',
                                                animationDelay: `${0.35 + i * 0.06}s`,
                                            }}
                                                onClick={(e) => openUserMenu(p, e)}
                                                onContextMenu={(e) => openUserMenu(p, e)}
                                            >
                                                {/* Left: Result */}
                                                <div style={{ minWidth: '60px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                    {hasData ? (
                                                        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: correct ? '#1ed760' : '#e91429' }}>
                                                            {correct ? '✅ Correct' : '❌ Wrong'}
                                                        </span>
                                                    ) : (
                                                        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                                            {isWaitingForAudio ? '...' : 'Ready'}
                                                        </span>
                                                    )}
                                                </div>

                                                {/* Center: Avatar + Name */}
                                                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                                                    <img src={p.avatar_url} style={{ width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                                                    <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{p.username}</span>
                                                    {hasData && rankChange !== 0 && (
                                                        <span style={{ fontSize: '0.6rem', fontWeight: 700, color: rankChange > 0 ? '#1ed760' : '#e91429' }}>
                                                            {rankChange > 0 ? `▲${rankChange}` : `▼${Math.abs(rankChange)}`}
                                                        </span>
                                                    )}
                                                </div>

                                                {/* Right: Points */}
                                                <div style={{ minWidth: '40px', textAlign: 'right', fontWeight: 800, fontSize: '0.95rem', color: correct ? '#1ed760' : '#e91429', flexShrink: 0, position: 'relative' }}>
                                                    {hasData ? (correct ? `+${p.last_round_points ?? 0}` : '0') : '-'}
                                                    {delta && (
                                                        <span key={`${p.id}-delta-${gameState?.current_round_index}`} className="score-delta">
                                                            +{delta}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>

                            <div style={{ marginTop: '16px', fontWeight: 'bold' }}>
                                {isWaitingForAudio ? 'Syncing Audio...' : 'Next round starting...'}
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

                            {/* Who Sang That mode — lyrics excerpt + 2 artist options */}
                            {isWhoSangThat && (
                                <div className="who-sang-that-stage" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', width: '100%' }}>
                                    {/* Lyrics excerpt */}
                                    <div className="lyrics-panel" style={{ textAlign: 'center', fontStyle: 'italic', lineHeight: 1.7 }}>
                                        {whoSangThatData?.excerpt?.length
                                            ? whoSangThatData.excerpt.map((line, i) => <div key={i}>{line}</div>)
                                            : <span style={{ opacity: 0.5 }}>Who sang this song?</span>
                                        }
                                    </div>
                                    {/* Artist option buttons */}
                                    {whoSangThatData?.options && (
                                        <div className="who-sang-that-options" style={{ display: 'flex', gap: '14px', justifyContent: 'center', flexWrap: 'nowrap', width: '100%', maxWidth: '420px' }}>
                                            {whoSangThatData.options.map((opt, i) => (
                                                <GuessWhoButton
                                                    key={i}
                                                    playerId={opt.name}
                                                    username={opt.name}
                                                    avatarUrl={opt.photo || '/placeholder-avatar.jpg'}
                                                    selected={guess.title === opt.name}
                                                    disabled={hasSubmitted || !canGuess}
                                                    onClick={() => {
                                                        if (hasSubmitted || !canGuess) return
                                                        setGuess({ title: opt.name, artist: '' })
                                                        setHasSubmitted(true)
                                                        soundManager.play('tick')
                                                        const playerRef = ref(db, `rooms/${code}/players/${profile.id}`)
                                                        update(playerRef, {
                                                            has_submitted: true,
                                                            last_guess: { title: opt.name, artist: '' },
                                                            submitted_at: serverTimestamp() as any
                                                        })
                                                    }}
                                                />
                                            ))}
                                        </div>
                                    )}
                                    {hasSubmitted && (
                                        <div style={{ color: 'var(--primary)', fontWeight: 600, fontSize: '0.9rem' }}>
                                            Answer locked in!
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Guess Who mode — avatar grid */}
                            {isGuessWho && (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', width: '100%' }}>
                                    {getGuessWhoRows(players.filter(p => !gameState?.is_sudden_death || duelingIds.includes(p.id))).map((row, rowIdx) => (
                                        <div key={rowIdx} style={{ display: 'flex', gap: '14px', justifyContent: 'center', flexWrap: 'nowrap' }}>
                                            {row.map(p => (
                                                <GuessWhoButton
                                                    key={p.id}
                                                    playerId={p.id}
                                                    username={p.username}
                                                    avatarUrl={p.avatar_url}
                                                    selected={guess.title === p.id}
                                                    disabled={hasSubmitted || !canGuess}
                                                    onClick={() => {
                                                        if (hasSubmitted || !canGuess) return
                                                        setGuess({ title: p.id, artist: '' })
                                                        // Auto-submit on tap
                                                        setHasSubmitted(true)
                                                        soundManager.play('tick')
                                                        const playerRef = ref(db, `rooms/${code}/players/${profile.id}`)
                                                        update(playerRef, {
                                                            has_submitted: true,
                                                            last_guess: { title: p.id, artist: '' },
                                                            submitted_at: serverTimestamp() as any
                                                        })
                                                    }}
                                                />
                                            ))}
                                        </div>
                                    ))}
                                    {hasSubmitted && (
                                        <div style={{ marginTop: '8px', color: 'var(--primary)', fontWeight: 600, fontSize: '0.9rem' }}>
                                            Answer locked in!
                                        </div>
                                    )}
                                </div>
                            )}

                            <div style={{ width: '100%', maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                {showArtistInput && (
                                    <div style={{ position: 'relative' }}>
                                        <input
                                            ref={artistInputRef}
                                            type="text" placeholder="Guess the Artist..."
                                            className="input-field"
                                            value={guess.artist}
                                            onChange={(e) => setGuess(prev => ({ ...prev, artist: e.target.value }))}
                                            onFocus={() => setArtistFocused(true)}
                                            onBlur={() => setTimeout(() => setArtistFocused(false), 150)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault()
                                                    if (showTitleInput) {
                                                        titleInputRef.current?.focus()
                                                    } else {
                                                        submitGuess()
                                                    }
                                                }
                                                if (e.key === 'Escape') setArtistFocused(false)
                                            }}
                                            disabled={hasSubmitted || !canGuess}
                                        />
                                        {artistFocused && artistSuggestions.length > 0 && (
                                            <div className="autocomplete-dropdown">
                                                {artistSuggestions.map((s, i) => (
                                                    <div
                                                        key={i}
                                                        className="autocomplete-item"
                                                        onMouseDown={() => {
                                                            setGuess(prev => ({ ...prev, artist: s }))
                                                            setArtistFocused(false)
                                                        }}
                                                    >
                                                        {s}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
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
                                                submitGuess()
                                            }
                                        }}
                                        disabled={hasSubmitted || !canGuess}
                                    />
                                )}
                                {!isGuessWho && (
                                    <button
                                        className="btn-primary"
                                        onClick={submitGuess}
                                        disabled={hasSubmitted || !canGuess}
                                    >
                                        {hasSubmitted ? 'ANSWER SUBMITTED' : 'SUBMIT GUESS'}
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* In-Game Leaderboard */}
            {(() => {
                const count = displayPlayers.length
                const isGridMode = count >= 5
                const isCompact = count >= 7
                return (
            <div className={`game-leaderboard${isGridMode ? ' grid-mode' : ''}${isCompact ? ' compact' : ''}`}>
                <div className="leaderboard-title">Leaderboard</div>
                {sortedDisplayPlayers.map((p, index) => {
                    const isSubmitter = p.has_submitted
                    const isMe = p.id === profile.id
                    const rank = index + 1

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

                            className={`player-card ${isSubmitter ? 'submitted' : ''} ${resultClass} ${isMe ? 'me' : ''}${rank <= 3 ? ` rank-top rank-${rank}` : ''}`}
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => openUserMenu(p, e)}
                            onContextMenu={(e) => openUserMenu(p, e)}
                        >
                            <div className={`rank-badge${rank <= 3 ? ` rank-badge--${rank}` : ''}`}>#{rank}</div>
                            <img src={p.avatar_url} style={{ width: '32px', height: '32px', borderRadius: '50%', flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div className="player-name" style={{ fontSize: '0.85rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.username}</div>
                                <div className="player-score" style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                                    {gameState.is_sudden_death
                                        ? <><AnimatedNumber value={p.sudden_death_score || 0} /> pts (SD)</>
                                        : <><AnimatedNumber value={p.score} /> pts</>
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
                )
            })()}

            {/* Footer: Score & Emotes */}
            <div className="score-hud">
                Score: <span className="text-primary"><AnimatedNumber value={totalScore} /></span>
            </div>
            {/* Audio Element Hidden */}
            <audio
                ref={onAudioRefChange}
                preload="auto"
                loop={true}
                style={{ display: 'none' }}
                onError={(e) => {
                    console.error('[Audio Event] onError:', e.nativeEvent)
                    handleAudioError(e)
                }}
                onPlay={() => {
                    console.log('[Audio Event] onPlay')
                    // Backup: Ensure status is playing
                    setAudioStatus('playing')
                    setAudioLoadError(false)
                }}
                onPause={() => console.log('[Audio Event] onPause')}
                onEnded={() => console.log('[Audio Event] onEnded')}
                onCanPlay={() => console.log('[Audio Event] onCanPlay')}
                onWaiting={() => console.log('[Audio Event] onWaiting')}
                onLoadedMetadata={(e) => {
                    const duration = e.currentTarget.duration
                    const roundTime = roomSettings?.time || 15
                    // Bullet Round: If the song preview is SHORTER than the time you have to guess
                    if (duration > 0 && duration < roundTime) {
                        console.log(`[Audio] Bullet Round Detected (Audio: ${duration.toFixed(1)}s < Round: ${roundTime}s)`)
                        setIsBulletRound(true)
                    } else {
                        setIsBulletRound(false)
                    }
                }}
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
