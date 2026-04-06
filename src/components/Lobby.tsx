'use client'

import { useState, useEffect, useMemo, useRef, type MouseEvent } from 'react'
import { useUser } from '@/context/UserContext'
import { db } from '@/lib/firebase'
import { ref, onValue, update, remove, onDisconnect, serverTimestamp } from 'firebase/database'
import { Users, Play, Copy, Check, Settings as SettingsIcon, Crown, LogOut, XCircle, Music, Zap, Mic2, FileText, Disc, CheckCircle, HelpCircle, ChevronDown, Mic, AlertTriangle, X, Image } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { fetchSpotifyData, addSongsToRoom, fetchChartTracks, type ChartKey, type FailedTrack } from '@/lib/spotify'
import { soundManager } from '@/lib/sounds'
import UserPopover from '@/components/UserPopover'
import LobbyChat from '@/components/LobbyChat'

type Player = {
    id: string
    username: string
    avatar_url: string
    score: number
    is_ready: boolean
    is_host: boolean
    is_importing?: boolean
    import_progress?: number
    joined_at?: number
    playlist_name?: string | null
    playlist_cover_url?: string | null
    playlist_song_count?: number | null
}

type RoomSettings = {
    rounds: number
    time: number
    mode: 'normal' | 'rapid' | 'artist_only' | 'song_only' | 'lyrics_only' | 'guess_who' | 'who_sang_that' | 'album_art'
    no_duplicates?: boolean
}

const RadialProgress = ({ progress, size = 24, strokeWidth = 3, color = 'currentColor' }: { progress: number, size?: number, strokeWidth?: number, color?: string }) => {
    const radius = (size - strokeWidth) / 2
    const circumference = radius * 2 * Math.PI
    const offset = circumference - (progress / 100) * circumference

    return (
        <div style={{ position: 'relative', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
                <circle
                    cx={size / 2} cy={size / 2} r={radius}
                    fill="transparent" stroke="rgba(255,255,255,0.2)" strokeWidth={strokeWidth}
                />
                <circle
                    cx={size / 2} cy={size / 2} r={radius}
                    fill="transparent" stroke={color} strokeWidth={strokeWidth}
                    strokeDasharray={circumference} strokeDashoffset={offset}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dashoffset 0.3s ease' }}
                />
            </svg>
        </div>
    )
}

function progressToColor(progress: number): string {
    const p = Math.max(0, Math.min(100, progress))
    if (p < 50) {
        const t = p / 50
        const r = 239 + Math.round((245 - 239) * t)
        const g = 68 + Math.round((158 - 68) * t)
        const b = 68 + Math.round((11 - 68) * t)
        return `rgb(${r}, ${g}, ${b})`
    }
    const t = (p - 50) / 50
    const r = 245 + Math.round((34 - 245) * t)
    const g = 158 + Math.round((197 - 158) * t)
    const b = 11 + Math.round((94 - 11) * t)
    return `rgb(${r}, ${g}, ${b})`
}

export default function Lobby({ roomCode, initialSettings, isHost, hostId }: { roomCode: string, initialSettings: any, isHost: boolean, hostId: string }) {
    const { profile } = useUser()
    const router = useRouter()

    // State
    const [players, setPlayers] = useState<Player[]>([])
    const [settings, setSettings] = useState<RoomSettings>(initialSettings)
    const [isStarting, setIsStarting] = useState(false)
    const [loadingMsg, setLoadingMsg] = useState('Starting...')
    const [copied, setCopied] = useState(false)
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
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
    const [creationProgress, setCreationProgress] = useState(0)
    const [shareUrl, setShareUrl] = useState('')


    // Import State
    const [importUrl, setImportUrl] = useState('')
    const [importing, setImporting] = useState(false)
    const [importProgress, setImportProgress] = useState(0)
    const [allSongs, setAllSongs] = useState<any[]>([])
    const [showChartMenu, setShowChartMenu] = useState(false)
    const [failedTracks, setFailedTracks] = useState<FailedTrack[]>([])
    const [showFailedModal, setShowFailedModal] = useState(false)
    const lastProgressRef = useRef(0)
    const prevPlayerCountRef = useRef(0)
    const prevAllReadyRef = useRef(false)
    const chartMenuRef = useRef<HTMLDivElement>(null)

    // Derived
    const currentPlayer = players.find(p => p.id === profile?.id)
    const totalSongs = allSongs.length
    const mySongs = useMemo(() => allSongs.filter(s => s.user_id === profile?.id), [allSongs, profile?.id])
    const hasImported = mySongs.length > 0

    // --------------------------------------------------------------------------------
    // 1. FIREBASE LISTENER
    // --------------------------------------------------------------------------------
    useEffect(() => {
        const roomRef = ref(db, `rooms/${roomCode}`)

        const unsubscribe = onValue(roomRef, (snapshot) => {
            const data = snapshot.val()

            if (!data) {
                router.push('/')
                return
            }

            if (data.settings) setSettings(data.settings)

            if (data.players) {
                setPlayers(Object.values(data.players))
            } else {
                setPlayers([])
            }

            if (data.songs) {
                setAllSongs(Object.values(data.songs))
            } else {
                setAllSongs([])
            }

            if (data.status === 'playing') {
                router.push(`/game/${roomCode}`)
            }
            if (typeof data.creation_progress === 'number') {
                setCreationProgress(data.creation_progress)
            }
        })

        return () => unsubscribe()
    }, [roomCode, router])

    // Play a sound when a new player joins
    useEffect(() => {
        if (players.length > prevPlayerCountRef.current && prevPlayerCountRef.current > 0) {
            soundManager.play('tick')
        }
        prevPlayerCountRef.current = players.length
    }, [players.length])

    // Play fanfare only when readiness transitions to all-ready
    useEffect(() => {
        const allReady = players.length >= 2 && players.every(p => p.is_ready)
        if (allReady && !prevAllReadyRef.current) {
            soundManager.play('all_ready')
        }
        prevAllReadyRef.current = allReady
    }, [players])

    // --------------------------------------------------------------------------------
    // 1.5 PRESENCE (Hosting Status)
    // --------------------------------------------------------------------------------
    useEffect(() => {
        if (!profile) return

        const presenceRef = ref(db, `users/${profile.id}/hosting`)

        // Set presence
        update(presenceRef, {
            roomCode,
            created_at: serverTimestamp()
        })

        // Clear on disconnect
        onDisconnect(presenceRef).remove()

        return () => {
            // Clear on unmount
            remove(presenceRef)
        }
    }, [profile, roomCode])

    // --------------------------------------------------------------------------------
    // 2. ACTIONS
    // --------------------------------------------------------------------------------
    const toggleReady = async () => {
        if (!profile) return
        const playerRef = ref(db, `rooms/${roomCode}/players/${profile.id}`)
        await update(playerRef, {
            is_ready: !currentPlayer?.is_ready
        })
    }

    const updateSettings = async (newSettings: Partial<RoomSettings>) => {
        if (!isHost) return
        const roomRef = ref(db, `rooms/${roomCode}`)
        await update(roomRef, {
            settings: { ...settings, ...newSettings }
        })
    }

    const handleImport = async () => {
        if (!importUrl || !profile) return

        // Restriction
        if (hasImported) {
            alert('You have already imported a playlist!')
            return
        }

        try {
            setImporting(true)
            setImportProgress(0)
            lastProgressRef.current = 0

            // Mark as importing in DB
            await update(ref(db, `rooms/${roomCode}/players/${profile.id}`), { is_importing: true, import_progress: 0 })

            const result = await fetchSpotifyData(importUrl, (value) => {
                const clamped = Math.min(100, Math.max(0, Math.round(value)))
                setImportProgress(clamped)
                const shouldUpdate = clamped === 100 || clamped - lastProgressRef.current >= 3
                if (shouldUpdate) {
                    lastProgressRef.current = clamped
                    void update(ref(db, `rooms/${roomCode}/players/${profile.id}`), { import_progress: clamped })
                }
            })
            await addSongsToRoom(roomCode, profile.id, result.tracks)
            if (result.failed.length > 0) setFailedTracks(result.failed)
            setImportUrl('')

            // Auto-Ready & Finished Importing
            const playerRef = ref(db, `rooms/${roomCode}/players/${profile.id}`)
            await update(playerRef, {
                is_ready: true,
                is_importing: false,
                import_progress: 100,
                playlist_name: result.collectionName || 'Imported Playlist',
                playlist_cover_url: result.collectionCoverUrl || null,
                playlist_song_count: result.tracks.length
            })

        } catch (error: any) {
            console.error(error)
            alert(error.message || 'Failed to import playlist')
            // Reset importing flag on error
            await update(ref(db, `rooms/${roomCode}/players/${profile.id}`), { is_importing: false, import_progress: 0 })
        } finally {
            setImporting(false)
            setImportProgress(0)
        }
    }

    useEffect(() => {
        if (!showChartMenu) return
        const handleClickOutside = (e: globalThis.MouseEvent) => {
            if (chartMenuRef.current && !chartMenuRef.current.contains(e.target as Node)) {
                setShowChartMenu(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [showChartMenu])

    useEffect(() => {
        setShareUrl(window.location.href)
    }, [])

    const handleChartImport = async (chartKey: ChartKey) => {
        if (!profile || hasImported) {
            if (hasImported) alert('You have already imported a playlist!')
            return
        }
        setShowChartMenu(false)
        try {
            setImporting(true)
            setImportProgress(0)
            lastProgressRef.current = 0
            await update(ref(db, `rooms/${roomCode}/players/${profile.id}`), { is_importing: true, import_progress: 0 })
            const result = await fetchChartTracks(chartKey, (value) => {
                const clamped = Math.min(100, Math.max(0, Math.round(value)))
                setImportProgress(clamped)
                const shouldUpdate = clamped === 100 || clamped - lastProgressRef.current >= 3
                if (shouldUpdate) {
                    lastProgressRef.current = clamped
                    void update(ref(db, `rooms/${roomCode}/players/${profile.id}`), { import_progress: clamped })
                }
            })
            await addSongsToRoom(roomCode, profile.id, result.tracks)
            if (result.failed.length > 0) setFailedTracks(result.failed)
            await update(ref(db, `rooms/${roomCode}/players/${profile.id}`), {
                is_ready: true,
                is_importing: false,
                import_progress: 100,
                playlist_name: result.collectionName || 'Imported Playlist',
                playlist_cover_url: result.collectionCoverUrl || null,
                playlist_song_count: result.tracks.length
            })
        } catch (error: any) {
            console.error(error)
            alert(error.message || 'Failed to import chart')
            await update(ref(db, `rooms/${roomCode}/players/${profile.id}`), { is_importing: false, import_progress: 0 })
        } finally {
            setImporting(false)
            setImportProgress(0)
        }
    }

    const startGame = async () => {
        if (!isHost) return

        if (totalSongs === 0) {
            alert('No songs available. Import a playlist first!')
            return
        }

        setIsStarting(true)
        // Only show "Loading Lyrics" if in lyrics mode, otherwise generic
        setLoadingMsg(settings.mode === 'lyrics_only' ? 'Loading Lyrics...' : 'Starting...')
        setCreationProgress(0)

        try {
            // 1. Call Secure Start API
            const res = await fetch('/api/game/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ roomCode, settings })
            })
            const data = await res.json()

            if (!res.ok) throw new Error(data.error || 'Failed to start game')

        } catch (e: any) {
            console.error(e)
            alert('Failed to start game: ' + e.message)
            setIsStarting(false)
        }
    }

    const kickPlayer = async (playerId: string) => {
        if (!isHost || playerId === hostId) return
        if (!confirm('Kick this player?')) return
        const playerRef = ref(db, `rooms/${roomCode}/players/${playerId}`)
        await remove(playerRef)
    }

    const leaveRoom = async () => {
        if (!profile) return
        const playerRef = ref(db, `rooms/${roomCode}/players/${profile.id}`)
        await remove(playerRef)
        router.push('/')
    }

    const handleDeleteClick = () => {
        if (!isHost) return
        setShowDeleteConfirm(true)
    }

    const confirmDeleteRoom = async () => {
        if (!isHost) return
        const roomRef = ref(db, `rooms/${roomCode}`)
        await remove(roomRef)
        router.push('/')
    }

    const copyCode = () => {
        navigator.clipboard.writeText(shareUrl || window.location.href)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    const modes = [
        { id: 'normal', icon: Music, label: 'Guess That Tune', description: 'Guess artist and song title from the clip.' },
        { id: 'rapid', icon: Zap, label: 'Quickdraw', description: 'Short fuse rounds built for fast answers.' },
        { id: 'artist_only', icon: Mic2, label: 'Only Artist Name', description: 'Only the artist matters. Song title guesses do not count.' },
        { id: 'song_only', icon: Disc, label: 'Only Song Name', description: 'Focus on song titles and ignore artist credit.' },
        { id: 'lyrics_only', icon: FileText, label: 'Lyrics Mode', description: 'Recognize songs from lyric snippets instead of audio alone.' },
        { id: 'guess_who', icon: HelpCircle, label: 'Who Got The Aux?', description: 'Figure out which player added the revealed song.' },
        { id: 'who_sang_that', icon: Mic, label: 'Who Sang That?', description: 'Identify the vocalist from the performance.' },
        { id: 'album_art', icon: Image, label: 'Album Art', description: 'Solve the round from the album cover reveal.' }
    ]

    const sortedPlayers = [...players].sort((a, b) => (a.joined_at || 0) - (b.joined_at || 0))
    const readyPlayers = players.filter(p => p.is_ready).length
    const importingPlayers = players.filter(p => p.is_importing).length
    const waitingPlayers = players.length - readyPlayers
    const isDenseRoster = players.length >= 10
    const statusTone = creationProgress > 0
        ? 'Launching match'
        : importingPlayers > 0
            ? 'Importing libraries'
            : players.length >= 2 && waitingPlayers === 0
                ? 'Everyone is locked in'
                : 'Waiting on players'
    const modeMeta = modes.find(mode => mode.id === settings.mode)
    const viewportHeight = 'calc(100dvh - 96px)'
    const readyPlayersCount = players.filter(p => p.is_ready).length
    const canHostStart = totalSongs > 0 && readyPlayersCount > 0 && !players.some(p => p.is_importing) && !isStarting

    return (
        <div style={{
            height: viewportHeight,
            padding: '16px 20px',
            width: '100%',
            maxWidth: 'none',
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            overflow: 'hidden'
        }}>
            <style jsx global>{`
                @keyframes playlistMarquee {
                    0% { transform: translateX(0); }
                    100% { transform: translateX(-50%); }
                }
            `}</style>
            <div className="glass-panel" style={{
                padding: '14px 18px',
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto auto auto auto',
                alignItems: 'center',
                gap: '12px',
                background: 'linear-gradient(135deg, rgba(20,20,24,0.92), rgba(26,26,30,0.86))',
                overflow: 'hidden'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--primary)', fontSize: '0.74rem', textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 800 }}>
                        <Users size={16} />
                        Lobby
                    </div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 900, whiteSpace: 'nowrap' }}>
                        {roomCode}
                    </div>
                    <button
                        onClick={copyCode}
                        style={{
                            minWidth: 'auto',
                            padding: '8px 10px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            borderRadius: '10px',
                            color: 'var(--text-main)'
                        }}
                        aria-label={copied ? 'Copied' : 'Copy invite link'}
                        title={copied ? 'Copied' : 'Copy invite link'}
                    >
                        {copied ? <Check size={16} /> : <Copy size={16} />}
                    </button>
                </div>
                <div className="glass-panel" style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.04)', width: '190px', minHeight: '58px' }}>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Status</div>
                    <div style={{ marginTop: '4px', fontWeight: 800, fontSize: '1rem', lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{statusTone}</div>
                </div>
                <div className="glass-panel" style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.04)', width: '190px', minHeight: '58px' }}>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Ready</div>
                    <div style={{ marginTop: '4px', fontWeight: 800, fontSize: '0.9rem', lineHeight: 1.2 }}>{readyPlayers}/{players.length || 1}</div>
                </div>
                <div className="glass-panel" style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.04)', width: '190px', minHeight: '58px' }}>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Songs</div>
                    <div style={{ marginTop: '4px', fontWeight: 800, fontSize: '0.9rem', lineHeight: 1.2 }}>{totalSongs}</div>
                </div>
                <div className="glass-panel" style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.04)', width: '190px', minHeight: '58px' }}>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Mode</div>
                    <div style={{ marginTop: '4px', fontWeight: 800, fontSize: '1rem', lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{modeMeta?.label || 'Unknown'}</div>
                </div>
            </div>

            <div style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(320px, 1.1fr) minmax(0, 1.5fr)',
                gap: '16px',
                alignItems: 'stretch',
                minHeight: 0,
                flex: 1,
                overflow: 'hidden'
            }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0, minHeight: 0 }}>
                    <div className="glass-panel" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px', minHeight: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                                    <Users className="text-primary" size={22} color="var(--primary)" />
                                    <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0 }}>Players</h2>
                                </div>
                            </div>
                        </div>

                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: isDenseRoster ? '10px' : '12px',
                            overflowY: 'auto',
                            minHeight: 0,
                            alignItems: 'stretch'
                        }}>
                            {sortedPlayers.map((p, idx) => {
                                const progress = Math.min(100, Math.max(0, Math.round(p.import_progress ?? 0)))
                                const playlistTitle = `${p.playlist_name || 'Imported Collection'}${typeof p.playlist_song_count === 'number' ? ` (${p.playlist_song_count})` : ''}`
                                const shouldScrollPlaylist = playlistTitle.length > (isDenseRoster ? 18 : 24)
                                const statusDotColor = p.is_importing
                                    ? {
                                        background: '#7dd3fc',
                                        boxShadow: '0 0 0 4px rgba(125,211,252,0.12)'
                                    }
                                    : p.is_ready
                                        ? {
                                            background: 'var(--primary)',
                                            boxShadow: '0 0 0 4px rgba(46,242,160,0.12)'
                                        }
                                        : {
                                            background: '#fde047',
                                            boxShadow: '0 0 0 4px rgba(250,204,21,0.10)'
                                        }

                                return (
                                    <div
                                        key={p.id}
                                        className={`glass-panel lobby-player-card${p.is_host ? ' is-host' : ''}`}
                                        style={{
                                            width: '100%',
                                            padding: isDenseRoster ? '8px 10px' : '10px 12px',
                                            border: '1px solid',
                                            borderColor: p.is_ready ? 'rgba(46,242,160,0.4)' : 'rgba(255,255,255,0.08)',
                                            background: p.is_ready
                                                ? 'linear-gradient(180deg, rgba(46,242,160,0.12), rgba(255,255,255,0.04))'
                                                : 'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03))',
                                            cursor: 'pointer',
                                            transition: 'transform 0.2s ease, background 0.2s ease, border-color 0.2s ease',
                                            display: 'grid',
                                            gridTemplateColumns: isHost
                                                ? `1fr ${isDenseRoster ? '165px' : '200px'} ${isDenseRoster ? '28px' : '30px'}`
                                                : `1fr ${isDenseRoster ? '165px' : '200px'}`,
                                            alignItems: 'center',
                                            gap: isDenseRoster ? '8px' : '10px',
                                            minHeight: isDenseRoster ? '62px' : '74px',
                                            animationDelay: `${idx * 0.07}s`
                                        }}
                                        onClick={(e) => openUserMenu(p, e)}
                                        onContextMenu={(e) => openUserMenu(p, e)}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.transform = 'translateY(-2px)'
                                            e.currentTarget.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.1), rgba(255,255,255,0.04))'
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.transform = 'translateY(0px)'
                                            e.currentTarget.style.background = p.is_ready
                                                ? 'linear-gradient(180deg, rgba(46,242,160,0.12), rgba(255,255,255,0.04))'
                                                : 'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03))'
                                        }}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: isDenseRoster ? '8px' : '10px', minWidth: 0, flex: 1 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: isDenseRoster ? '8px' : '10px', minWidth: 0, flex: 1 }}>
                                                <img src={p.avatar_url} alt={p.username} style={{ width: isDenseRoster ? '48px' : '58px', height: isDenseRoster ? '48px' : '58px', borderRadius: isDenseRoster ? '14px' : '18px', objectFit: 'cover', flexShrink: 0 }} />
                                                <div style={{ minWidth: 0, flex: 1 }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                                        <span style={{
                                                            width: isDenseRoster ? '8px' : '9px',
                                                            height: isDenseRoster ? '8px' : '9px',
                                                            borderRadius: '999px',
                                                            flexShrink: 0,
                                                            ...statusDotColor
                                                        }} />
                                                        <div style={{ fontWeight: 800, fontSize: isDenseRoster ? '0.92rem' : '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.username}</div>
                                                        {p.id === hostId && <Crown size={16} color="#fbbf24" />}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Right section: playlist info or import progress — fixed-width grid column */}
                                        <div style={{ minWidth: 0, overflow: 'hidden' }}>
                                            {p.is_importing ? (
                                                <div>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                                                        <span>Importing</span>
                                                        <span>‎ {progress}%</span>
                                                    </div>
                                                    <div style={{ height: '8px', width: '100%', background: 'rgba(255,255,255,0.08)', borderRadius: '999px', overflow: 'hidden' }}>
                                                        <div style={{
                                                            height: '100%',
                                                            width: `${progress}%`,
                                                            background: `linear-gradient(90deg, ${progressToColor(progress)}, var(--primary))`,
                                                            transition: 'width 0.3s ease-out, background 0.3s ease-out'
                                                        }} />
                                                    </div>
                                                </div>
                                            ) : (p.playlist_name || p.playlist_cover_url) ? (
                                                <div style={{ display: 'flex', alignItems: 'center', gap: isDenseRoster ? '8px' : '10px' }}>
                                                    <img
                                                        src={p.playlist_cover_url || '/placeholder-cover.jpg'}
                                                        alt={p.playlist_name || 'Playlist cover'}
                                                        style={{
                                                            width: isDenseRoster ? '30px' : '36px',
                                                            height: isDenseRoster ? '30px' : '36px',
                                                            borderRadius: '9px',
                                                            objectFit: 'cover',
                                                            flexShrink: 0
                                                        }}
                                                        onError={(e) => { e.currentTarget.src = '/placeholder-cover.jpg' }}
                                                    />
                                                    <div style={{ minWidth: 0, overflow: 'hidden', flex: 1 }}>
                                                        <div style={{ fontSize: isDenseRoster ? '0.8rem' : '0.9rem', fontWeight: 800, overflow: 'hidden' }}>
                                                            {shouldScrollPlaylist ? (
                                                                <div style={{ display: 'flex', width: 'max-content', animation: 'playlistMarquee 9s linear infinite', whiteSpace: 'nowrap' }}>
                                                                    <span style={{ paddingRight: '32px' }}>{playlistTitle}</span>
                                                                    <span style={{ paddingRight: '32px' }}>{playlistTitle}</span>
                                                                </div>
                                                            ) : (
                                                                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{playlistTitle}</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            ) : null}
                                        </div>

                                        {/* Kick slot — always rendered when isHost so the grid column is always present */}
                                        {isHost && (
                                            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                                {p.id !== hostId && (
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); kickPlayer(p.id) }}
                                                        style={{
                                                            color: 'var(--error)',
                                                            padding: isDenseRoster ? '5px' : '6px',
                                                            borderRadius: isDenseRoster ? '9px' : '10px',
                                                            border: '1px solid rgba(239,68,68,0.24)',
                                                            background: 'rgba(239,68,68,0.08)'
                                                        }}
                                                    >
                                                        <XCircle size={isDenseRoster ? 13 : 14} />
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>

                        {selectedPlayer && (
                            <UserPopover
                                isOpen={!!selectedPlayer}
                                targetUser={selectedPlayer}
                                onClose={closeUserMenu}
                                currentUserProfileId={profile?.id}
                                anchorPoint={menuAnchor || undefined}
                            />
                        )}
                    </div>

                    {profile && (
                        <div className="glass-panel" style={{ padding: '16px', minHeight: 0, display: 'flex', flexDirection: 'column', flex: '0 0 240px' }}>
                            <LobbyChat
                                roomCode={roomCode}
                                userId={profile.id}
                                username={profile.username}
                                avatarUrl={profile.avatar_url}
                            />
                        </div>
                    )}
                </div>

                <div className="glass-panel" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto', minWidth: 0, minHeight: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
                                <SettingsIcon className="text-primary" size={24} color="var(--primary)" />
                                <h2 style={{ fontSize: '1.35rem', fontWeight: 800, margin: 0 }}>Match Setup</h2>
                            </div>
                        </div>
                        {isHost ? (
                            <button onClick={handleDeleteClick} style={{ display: 'flex', gap: '8px', padding: '10px 16px', color: 'var(--error)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '999px', alignItems: 'center', fontSize: '0.9rem', background: 'rgba(239,68,68,0.08)' }}><LogOut size={16} /></button>
                        ) : (
                            <button onClick={leaveRoom} style={{ display: 'flex', gap: '8px', padding: '10px 16px', color: 'var(--error)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '999px', alignItems: 'center', fontSize: '0.9rem', background: 'rgba(239,68,68,0.08)' }}><LogOut size={16} /></button>
                        )}
                    </div>

                    {/* IMPORT SECTION */}
                    <div className="glass-panel" style={{ padding: '16px', background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.03))', overflow: 'visible' }}>
                    <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span>Import Playlist</span>
                        </div>
                    </h3>

                        {hasImported ? (
                        <div style={{
                            background: 'rgba(46, 242, 160, 0.12)', border: '1px solid rgba(46, 242, 160, 0.25)',
                            borderRadius: '8px', padding: '12px', display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--primary)'
                        }}>
                            <CheckCircle size={24} style={{ flexShrink: 0 }} />
                            <div style={{ fontWeight: 600, flex: 1 }}>Playlist Imported ({mySongs.length} songs)</div>
                            {failedTracks.length > 0 && (
                                <button
                                    onClick={() => setShowFailedModal(true)}
                                    title={`${failedTracks.length} songs couldn't be imported`}
                                    style={{
                                        background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
                                        borderRadius: '8px', padding: '6px 10px',
                                        display: 'flex', alignItems: 'center', gap: '6px',
                                        cursor: 'pointer', color: '#ef4444', fontSize: '0.8rem', fontWeight: 600, flexShrink: 0,
                                    }}
                                >
                                    <AlertTriangle size={16} />
                                    {failedTracks.length}
                                </button>
                            )}
                        </div>
                        ) : (
                            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                            <input
                                type="text" placeholder="Spotify or YouTube URL..."
                                value={importUrl} onChange={(e) => setImportUrl(e.target.value)}
                                className="ui-input"
                                style={{ flex: 1, padding: '10px' }}
                            />
                            <div className="import-split-btn" ref={chartMenuRef}>
                                <button
                                    onClick={handleImport}
                                    disabled={importing || !importUrl}
                                    className="btn-primary import-split-btn__main"
                                >
                                    {importing ? (
                                        <span className="import-progress">
                                            <span
                                                className="import-progress__ring"
                                                style={{
                                                    ['--progress' as any]: importProgress,
                                                    borderTopColor: progressToColor(importProgress),
                                                    borderLeftColor: progressToColor(importProgress),
                                                    borderRightColor: 'transparent',
                                                    borderBottomColor: 'transparent'
                                                }}
                                            />
                                            <span className="import-progress__text">{importProgress}%</span>
                                        </span>
                                    ) : 'Import'}
                                </button>
                                <button
                                    onClick={() => setShowChartMenu(prev => !prev)}
                                    disabled={importing}
                                    className="btn-primary import-split-btn__chevron"
                                    aria-label="Show top charts"
                                    aria-expanded={showChartMenu}
                                >
                                    <ChevronDown size={16} strokeWidth={2.5} />
                                </button>
                                {showChartMenu && (
                                    <div className="chart-dropdown">
                                        <button className="chart-dropdown__item" onClick={() => handleChartImport('worldwide')}>
                                            🌍 Top 100 Worldwide
                                        </button>
                                        <button className="chart-dropdown__item" onClick={() => handleChartImport('portugal')}>
                                            <span style={{
                                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                width: '18px', height: '13px', borderRadius: '2px', fontSize: '0.6rem',
                                                fontWeight: 900, letterSpacing: '0px', flexShrink: 0,
                                                background: 'linear-gradient(to right, #006600 40%, #ff0000 40%)',
                                                color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.6)'
                                            }}>PT</span>
                                            Top 100 Portugal
                                        </button>
                                    </div>
                                )}
                            </div>
                            </div>
                        )}
                    </div>

                    {/* GAME MODES */}
                    <div className="glass-panel" style={{ padding: '16px', background: 'rgba(255,255,255,0.03)' }}>
                        <label style={{ display: 'block', marginBottom: '14px', fontWeight: 700 }}>Game Mode</label>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px' }}>
                        {modes.map(mode => (
                            <button
                                key={mode.id}
                                onClick={() => updateSettings({ mode: mode.id as any })}
                                disabled={!isHost}
                                title={mode.description}
                                aria-label={`${mode.label}. ${mode.description}`}
                                style={{
                                    padding: '12px 8px', borderRadius: '12px',
                                    background: settings.mode === mode.id ? 'rgba(46,242,160,0.18)' : 'rgba(255,255,255,0.04)',
                                    color: settings.mode === mode.id ? 'white' : 'var(--text-muted)',
                                    border: '1px solid', borderColor: settings.mode === mode.id ? 'rgba(46,242,160,0.75)' : 'rgba(255,255,255,0.1)',
                                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
                                    transition: 'all 0.2s',
                                    opacity: (!isHost && settings.mode !== mode.id) ? 0.5 : 1,
                                    transform: settings.mode === mode.id ? 'scale(1.02)' : 'scale(1)',
                                    boxShadow: settings.mode === mode.id ? '0 0 0 1px rgba(46,242,160,0.25), 0 0 24px rgba(46,242,160,0.22)' : 'none'
                                }}
                                onMouseEnter={(e) => {
                                    if (!isHost || settings.mode === mode.id) return
                                    e.currentTarget.style.transform = 'translateY(-2px) scale(1.01)'
                                    e.currentTarget.style.boxShadow = '0 8px 20px rgba(0,0,0,0.28)'
                                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.24)'
                                }}
                                onMouseLeave={(e) => {
                                    if (!isHost || settings.mode === mode.id) return
                                    e.currentTarget.style.transform = 'scale(1)'
                                    e.currentTarget.style.boxShadow = 'none'
                                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
                                }}
                            >
                                <mode.icon size={20} />
                                <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{mode.label}</span>
                            </button>
                        ))}
                        </div>
                    </div>

                    {/* SLIDERS */}
                    <div className="glass-panel" style={{ padding: '16px', background: 'rgba(255,255,255,0.03)', display: 'grid', gap: '14px' }}>
                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                                <label>Rounds</label>
                                <span style={{ fontWeight: 'bold' }}>{settings.rounds}</span>
                            </div>
                            <input
                                type="range" min="5" max="50" step="5"
                                value={settings.rounds}
                                onChange={(e) => updateSettings({ rounds: parseInt(e.target.value) })}
                                disabled={!isHost}
                                style={{ width: '100%', accentColor: 'var(--primary)', height: '6px', borderRadius: '3px', cursor: 'pointer' }}
                            />
                        </div>

                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                                <label>Time per Round</label>
                                <span style={{ fontWeight: 'bold' }}>{settings.time}s</span>
                            </div>
                            <input
                                type="range" min="5" max="30" step="5"
                                value={settings.time}
                                onChange={(e) => updateSettings({ time: parseInt(e.target.value) })}
                                disabled={!isHost}
                                style={{ width: '100%', accentColor: 'var(--primary)' }}
                            />
                        </div>

                        <div style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            cursor: isHost ? 'pointer' : 'default',
                            opacity: isHost ? 1 : 0.5
                        }}
                            onClick={() => isHost && updateSettings({ no_duplicates: !settings.no_duplicates })}
                        >
                            <div>
                                <div style={{ fontWeight: 700 }}>No Duplicates</div>
                            </div>
                            <div style={{
                                width: '44px', height: '24px', borderRadius: '999px', position: 'relative', flexShrink: 0,
                                background: settings.no_duplicates ? 'var(--primary)' : 'rgba(255,255,255,0.12)',
                                transition: 'background 0.2s ease'
                            }}>
                                <div style={{
                                    position: 'absolute', top: '3px',
                                    left: settings.no_duplicates ? '23px' : '3px',
                                    width: '18px', height: '18px', borderRadius: '50%',
                                    background: 'white', transition: 'left 0.2s ease'
                                }} />
                            </div>
                        </div>
                    </div>

                    <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'center' }}>
                    {isHost ? (
                        <button
                            onClick={startGame}
                            disabled={!canHostStart}
                            className="btn-primary"
                            style={{
                                padding: '16px 48px', fontSize: '1.2rem', width: '100%',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px',
                                minHeight: '60px', height: '60px',
                                opacity: canHostStart ? 1 : 0.55,
                                background: canHostStart ? undefined : 'rgba(148,163,184,0.18)',
                                borderColor: canHostStart ? undefined : 'rgba(148,163,184,0.28)',
                                color: canHostStart ? undefined : 'rgba(255,255,255,0.75)',
                                cursor: canHostStart ? 'pointer' : 'not-allowed'
                            }}
                            title={
                                totalSongs === 0
                                    ? 'Import a playlist before starting'
                                    : readyPlayersCount === 0
                                        ? 'At least one player must be ready'
                                        : players.some(p => p.is_importing)
                                            ? 'Wait for playlist imports to finish'
                                            : 'Start game'
                            }
                        >
                            {isStarting ? (
                                <><RadialProgress progress={creationProgress} size={20} strokeWidth={3} /> {loadingMsg}</>
                            ) : players.some(p => p.is_importing) ? (
                                <><RadialProgress progress={importProgress} size={20} strokeWidth={3} /> Importing playlist...</>
                            ) : totalSongs === 0 ? (
                                'Import a playlist to start'
                            ) : readyPlayersCount === 0 ? (
                                'Need one ready player'
                            ) : (
                                <><Play fill="currentColor" /> START GAME</>
                            )}
                        </button>
                    ) : (
                        <button
                            onClick={toggleReady}
                            disabled={creationProgress > 0}
                            style={{
                                padding: '16px 48px', fontSize: '1.2rem', width: '100%', cursor: 'pointer', borderRadius: '99px',
                                border: (creationProgress > 0) ? '1px solid var(--primary)' : (currentPlayer?.is_ready ? '2px solid var(--primary)' : '1px solid rgba(255,255,255,0.1)'),
                                background: (creationProgress > 0) ? 'var(--bg-secondary)' : (currentPlayer?.is_ready ? 'rgba(46, 242, 160, 0.2)' : 'rgba(255, 255, 255, 0.04)'),
                                color: (creationProgress > 0) ? 'white' : (currentPlayer?.is_ready ? 'white' : 'var(--text-muted)'),
                                fontWeight: 700,
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px',
                                minHeight: '60px', height: '60px'
                            }}
                        >
                            {creationProgress > 0 ? (
                                <><RadialProgress progress={creationProgress} size={20} strokeWidth={3} /> STARTING...</>
                            ) : (
                                currentPlayer?.is_ready
                                    ? (players.some(p => p.is_importing) ? 'Waiting for other players...' : 'Waiting for host...')
                                    : hasImported ? 'CLICK TO READY UP' : 'SKIP IMPORT / READY'
                            )}
                        </button>
                    )}
                    </div>
                </div>
            </div>

            {/* Failed Tracks Modal */}
            {showFailedModal && failedTracks.length > 0 && (
                <div style={{
                    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
                    backdropFilter: 'blur(8px)', zIndex: 100,
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                }} onClick={() => setShowFailedModal(false)}>
                    <div className="glass-panel" style={{ padding: '24px', width: '100%', maxWidth: '440px', margin: '0 16px', maxHeight: '70vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#ef4444' }}>
                                <AlertTriangle size={20} />
                                <h3 style={{ fontWeight: 700, margin: 0 }}>{failedTracks.length} Songs Failed</h3>
                            </div>
                            <button onClick={() => setShowFailedModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                                <X size={20} />
                            </button>
                        </div>
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '16px' }}>
                            These songs couldn't be found, and so they were skipped.
                        </p>
                        <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {failedTracks.map((t, i) => (
                                <div key={i} style={{
                                    padding: '8px 12px', borderRadius: '8px',
                                    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)',
                                    fontSize: '0.85rem',
                                }}>
                                    <span style={{ color: 'var(--text-main)' }}>{t.title || 'Unknown'}</span>
                                    {t.artist && <span style={{ color: 'var(--text-muted)' }}> — {t.artist}</span>}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Room Confirmation Modal */}
            {showDeleteConfirm && (
                <div style={{
                    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
                    backdropFilter: 'blur(8px)', zIndex: 100,
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                    <div className="glass-panel" style={{ padding: '32px', width: '100%', maxWidth: '400px', textAlign: 'center', border: '1px solid var(--error)' }}>
                        <h2 style={{ marginBottom: '16px', fontSize: '1.5rem', fontWeight: 700, color: 'var(--error)' }}>Delete Room?</h2>
                        <p style={{ marginBottom: '24px', color: 'var(--text-muted)' }}>
                            Are you sure you want to delete this room? All players will be kicked and the game will end.
                        </p>
                        <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
                            <button
                                onClick={() => setShowDeleteConfirm(false)}
                                style={{
                                    padding: '12px 24px', borderRadius: '8px', cursor: 'pointer',
                                    background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid rgba(255,255,255,0.1)'
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmDeleteRoom}
                                className="btn-primary"
                                style={{
                                    padding: '12px 24px', background: 'var(--error)', borderColor: 'var(--error)',
                                    color: 'white', display: 'flex', alignItems: 'center', gap: '8px'
                                }}
                            >
                                <LogOut size={16} /> Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
