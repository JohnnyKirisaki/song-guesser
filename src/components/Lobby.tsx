'use client'

import { useState, useEffect, useMemo } from 'react'
import { useUser } from '@/context/UserContext'
import { db } from '@/lib/firebase'
import { ref, onValue, update, remove } from 'firebase/database'
import { Users, Play, Copy, Check, Settings as SettingsIcon, Loader2, Crown, LogOut, XCircle, Music, Zap, Mic2, FileText, Disc, CheckCircle } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { fetchSpotifyData, addSongsToRoom } from '@/lib/spotify'

type Player = {
    id: string
    username: string
    avatar_url: string
    score: number
    is_ready: boolean
    is_host: boolean
    is_importing?: boolean
}

type RoomSettings = {
    rounds: number
    time: number
    mode: 'normal' | 'rapid' | 'artist_only' | 'song_only' | 'lyrics_only'
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

    // Import State
    const [importUrl, setImportUrl] = useState('')
    const [importing, setImporting] = useState(false)
    const [importProgress, setImportProgress] = useState(0)
    const [allSongs, setAllSongs] = useState<any[]>([])

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
        })

        return () => unsubscribe()
    }, [roomCode, router])

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

            // Mark as importing in DB
            await update(ref(db, `rooms/${roomCode}/players/${profile.id}`), { is_importing: true })

            const tracks = await fetchSpotifyData(importUrl, (value) => {
                const clamped = Math.min(100, Math.max(0, Math.round(value)))
                setImportProgress(clamped)
            })
            await addSongsToRoom(roomCode, profile.id, tracks)
            setImportUrl('')

            // Auto-Ready & Finished Importing
            const playerRef = ref(db, `rooms/${roomCode}/players/${profile.id}`)
            await update(playerRef, { is_ready: true, is_importing: false })

        } catch (error: any) {
            console.error(error)
            alert(error.message || 'Failed to import playlist')
            // Reset importing flag on error
            await update(ref(db, `rooms/${roomCode}/players/${profile.id}`), { is_importing: false })
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
        setLoadingMsg('Strategies...') // Initial Loading Message

        try {
            // 1. Prepare Payload (Generates Playlist)
            const { prepareGamePayload } = await import('@/lib/game-logic')
            const { updates, playlist } = await prepareGamePayload(roomCode, settings)

            // 2. Lyrics Mode: Prefetch ONLY relevant songs
            if (settings.mode === 'lyrics_only') {
                const songsToFetch = playlist // ONLY the songs selected for this game
                console.log(`[Lobby] Prefetching lyrics for ${songsToFetch.length} selected songs...`)

                const BATCH_SIZE = 5
                const lyricsUpdates: Record<string, string> = {}

                for (let i = 0; i < songsToFetch.length; i += BATCH_SIZE) {
                    const batch = songsToFetch.slice(i, i + BATCH_SIZE)
                    setLoadingMsg('Fetching Lyrics...')

                    await Promise.all(batch.map(async (song) => {
                        try {
                            const res = await fetch(`/api/lyrics?artist=${encodeURIComponent(song.artist_name)}&title=${encodeURIComponent(song.track_name)}`)
                            const data = await res.json()
                            if (data.lyrics) {
                                // Add to batched updates object
                                lyricsUpdates[song.id] = data.lyrics
                            }
                        } catch (e) {
                            console.error(`Failed to fetch lyrics for ${song.track_name}`, e)
                        }
                    }))
                    // Small delay to be nice to API
                    await new Promise(r => setTimeout(r, 200))
                }

                // Write ALL lyrics at once to `rooms/${code}/lyrics_cache`
                if (Object.keys(lyricsUpdates).length > 0) {
                    // Merge with main updates? No, separate write is cleaner for large data.
                    // Actually, `update` works great with deep paths.
                    // We'll write to lyrics_cache node directly.
                    await update(ref(db, `rooms/${roomCode}/lyrics_cache`), lyricsUpdates)
                }
            }

            setLoadingMsg('Starting...')

            // 3. Commit Game Start
            await update(ref(db), updates)

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

    const deleteRoom = async () => {
        if (!isHost) return
        if (!confirm('Delete Room?')) return
        const roomRef = ref(db, `rooms/${roomCode}`)
        await remove(roomRef)
        router.push('/')
    }

    const copyCode = () => {
        navigator.clipboard.writeText(window.location.href)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    const modes = [
        { id: 'normal', icon: Music, label: 'Normal' },
        { id: 'rapid', icon: Zap, label: 'Rapid' },
        { id: 'artist_only', icon: Mic2, label: 'Artist' },
        { id: 'song_only', icon: Disc, label: 'Song' },
        { id: 'lyrics_only', icon: FileText, label: 'Lyrics' }
    ]

    return (
        <div style={{
            display: 'flex', gap: '24px', height: 'calc(100vh - 100px)',
            padding: '24px', maxWidth: '1200px', margin: '0 auto', flexWrap: 'wrap'
        }}>
            {/* LEFT: Player List */}
            <div className="glass-panel" style={{ flex: '1 1 300px', padding: '24px', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                    <Users className="text-primary" size={24} color="var(--primary)" />
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Players ({players.length})</h2>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto', flex: 1 }}>
                    {players.map((p) => (
                        <div key={p.id} className="glass-panel" style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px',
                            border: '1px solid', borderColor: p.is_ready ? 'var(--primary)' : 'rgba(255,255,255,0.08)',
                            background: p.is_ready ? 'rgba(46, 242, 160, 0.08)' : 'rgba(255, 255, 255, 0.04)'
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <img src={p.avatar_url} alt={p.username} style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }} />
                                <div>
                                    <div style={{ fontWeight: 700 }}>{p.username}</div>
                                    <div style={{ fontSize: '0.8rem', color: p.is_ready ? 'var(--primary)' : 'var(--text-muted)' }}>
                                        {p.is_ready ? 'READY' : 'NOT READY'}
                                    </div>
                                </div>
                            </div>
                            {isHost && p.id !== hostId && (
                                <button onClick={() => kickPlayer(p.id)} style={{ color: 'var(--error)', padding: '4px' }}><XCircle size={16} /></button>
                            )}
                            {p.id === hostId && <Crown size={16} color="#fbbf24" />}
                        </div>
                    ))}
                </div>

                <div style={{ marginTop: '24px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <span style={{ fontWeight: 700 }}>Room Code:</span>
                        <span style={{ fontWeight: 900, letterSpacing: '2px' }}>{roomCode}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <input readOnly value={window.location.href} className="ui-input" style={{ flex: 1, textOverflow: 'ellipsis', padding: '8px', color: 'var(--text-muted)' }} />
                        <button onClick={copyCode} className="btn-primary" style={{ padding: '8px 16px', minWidth: 'auto' }}>
                            {copied ? <Check size={18} /> : <Copy size={18} />}
                        </button>
                    </div>
                </div>
            </div>

            {/* RIGHT: Settings */}
            <div className="glass-panel" style={{ flex: '1.5 1 400px', padding: '32px', display: 'flex', flexDirection: 'column', gap: '24px', overflowY: 'auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <SettingsIcon className="text-primary" size={24} color="var(--primary)" />
                        <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Game Settings</h2>
                    </div>
                    {isHost ? (
                        <button onClick={deleteRoom} style={{ display: 'flex', gap: '8px', padding: '8px 16px', color: 'var(--error)', border: '1px solid var(--error)', borderRadius: '99px', alignItems: 'center', fontSize: '0.9rem' }}><LogOut size={16} /> Delete Room</button>
                    ) : (
                        <button onClick={leaveRoom} style={{ display: 'flex', gap: '8px', padding: '8px 16px', color: 'var(--error)', border: '1px solid var(--error)', borderRadius: '99px', alignItems: 'center', fontSize: '0.9rem' }}><LogOut size={16} /> Leave</button>
                    )}
                </div>

                {/* IMPORT SECTION */}
                <div className="glass-panel" style={{ padding: '20px', background: 'rgba(255,255,255,0.03)' }}>
                    <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span>Import Playlist</span>
                        </div>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Total: {totalSongs}</span>
                    </h3>

                    {hasImported ? (
                        <div style={{
                            background: 'rgba(46, 242, 160, 0.12)', border: '1px solid rgba(46, 242, 160, 0.25)',
                            borderRadius: '8px', padding: '12px', display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--primary)'
                        }}>
                            <CheckCircle size={24} />
                            <div style={{ fontWeight: 600 }}>Playlist Imported ({mySongs.length} songs)</div>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', gap: '12px' }}>
                            <input
                                type="text" placeholder="Spotify or YouTube URL..."
                                value={importUrl} onChange={(e) => setImportUrl(e.target.value)}
                                className="ui-input"
                                style={{ flex: 1, padding: '10px' }}
                            />
                            <button
                                onClick={handleImport} disabled={importing || !importUrl}
                                className="btn-primary" style={{ padding: '0 20px', fontSize: '0.9rem', minWidth: '100px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            >
                                {importing ? (
                                    <span className="import-progress">
                                        <span className="import-progress__ring" style={{ ['--progress' as any]: importProgress }} />
                                        <span className="import-progress__text">{importProgress}%</span>
                                    </span>
                                ) : 'Import'}
                            </button>
                        </div>
                    )}
                </div>

                {/* GAME MODES */}
                <div>
                    <label style={{ display: 'block', marginBottom: '12px', fontWeight: 600 }}>Game Mode</label>
                    <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '8px' }}>
                        {modes.map(mode => (
                            <button
                                key={mode.id}
                                onClick={() => updateSettings({ mode: mode.id as any })}
                                disabled={!isHost}
                                style={{
                                    flex: '1', minWidth: '80px', padding: '12px 8px', borderRadius: '12px',
                                    background: settings.mode === mode.id ? 'var(--primary)' : 'rgba(255,255,255,0.04)',
                                    color: settings.mode === mode.id ? '#04110b' : 'var(--text-muted)',
                                    border: '1px solid', borderColor: settings.mode === mode.id ? 'var(--primary)' : 'rgba(255,255,255,0.1)',
                                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
                                    transition: 'all 0.2s', opacity: (!isHost && settings.mode !== mode.id) ? 0.5 : 1
                                }}
                            >
                                <mode.icon size={20} />
                                <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{mode.label}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* SLIDERS */}
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

                <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'center' }}>
                    {isHost ? (
                        <button
                            onClick={startGame}
                            disabled={isStarting || players.some(p => p.is_importing)}
                            className="btn-primary"
                            style={{ padding: '16px 48px', fontSize: '1.2rem', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}
                        >
                            {isStarting ? (
                                <><Loader2 className="animate-spin" /> {loadingMsg}</>
                            ) : players.some(p => p.is_importing) ? (
                                <><Loader2 className="animate-spin" /> Waiting for imports...</>
                            ) : (
                                <><Play fill="currentColor" /> START GAME</>
                            )}
                        </button>
                    ) : (
                        <button
                            onClick={toggleReady}
                            style={{
                                padding: '16px 48px', fontSize: '1.2rem', width: '100%', cursor: 'pointer', borderRadius: '99px',
                                border: currentPlayer?.is_ready ? '2px solid var(--primary)' : '1px solid rgba(255,255,255,0.1)',
                                background: currentPlayer?.is_ready ? 'rgba(46, 242, 160, 0.2)' : 'rgba(255, 255, 255, 0.04)'
                                ,
                                color: currentPlayer?.is_ready ? 'white' : 'var(--text-muted)', fontWeight: 700
                            }}
                        >
                            {currentPlayer?.is_ready ? 'READY!' : hasImported ? 'CLICK TO READY UP' : 'SKIP IMPORT / READY'}
                        </button>
                    )}
                </div>

                {!isHost && (
                    <div style={{ textAlign: 'center', marginTop: '16px', color: 'var(--text-muted)' }}>
                        {currentPlayer?.is_ready ? 'Waiting for host...' : 'Import songs or click Ready to skip.'}
                    </div>
                )}
            </div>
        </div>
    )
}
