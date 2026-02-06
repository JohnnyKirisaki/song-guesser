'use client'

import { useState, useEffect, useMemo, useRef, type MouseEvent } from 'react'
import { useUser } from '@/context/UserContext'
import { db } from '@/lib/firebase'
import { ref, onValue, update, remove, onDisconnect, serverTimestamp } from 'firebase/database'
import { Users, Play, Copy, Check, Settings as SettingsIcon, Loader2, Crown, LogOut, XCircle, Music, Zap, Mic2, FileText, Disc, CheckCircle } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { fetchSpotifyData, addSongsToRoom } from '@/lib/spotify'
import UserPopover from '@/components/UserPopover'

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
}

type RoomSettings = {
    rounds: number
    time: number
    mode: 'normal' | 'rapid' | 'artist_only' | 'song_only' | 'lyrics_only'
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


    // Import State
    const [importUrl, setImportUrl] = useState('')
    const [importing, setImporting] = useState(false)
    const [importProgress, setImportProgress] = useState(0)
    const [allSongs, setAllSongs] = useState<any[]>([])
    const lastProgressRef = useRef(0)

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

            const tracks = await fetchSpotifyData(importUrl, (value) => {
                const clamped = Math.min(100, Math.max(0, Math.round(value)))
                setImportProgress(clamped)
                const shouldUpdate = clamped === 100 || clamped - lastProgressRef.current >= 3
                if (shouldUpdate) {
                    lastProgressRef.current = clamped
                    void update(ref(db, `rooms/${roomCode}/players/${profile.id}`), { import_progress: clamped })
                }
            })
            await addSongsToRoom(roomCode, profile.id, tracks)
            setImportUrl('')

            // Auto-Ready & Finished Importing
            const playerRef = ref(db, `rooms/${roomCode}/players/${profile.id}`)
            await update(playerRef, { is_ready: true, is_importing: false, import_progress: 100 })

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
                    {[...players].sort((a, b) => (a.joined_at || 0) - (b.joined_at || 0)).map((p) => (
                        <div key={p.id} className="glass-panel" style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px',
                            border: '1px solid', borderColor: p.is_ready ? 'var(--primary)' : 'rgba(255,255,255,0.08)',
                            background: p.is_ready ? 'rgba(46, 242, 160, 0.08)' : 'rgba(255, 255, 255, 0.04)',
                            cursor: 'pointer', transition: 'background 0.2s'
                        }}
                            onClick={(e) => openUserMenu(p, e)}
                            onContextMenu={(e) => openUserMenu(p, e)}
                            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                            onMouseLeave={(e) => e.currentTarget.style.background = p.is_ready ? 'rgba(46, 242, 160, 0.08)' : 'rgba(255, 255, 255, 0.04)'}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <img src={p.avatar_url} alt={p.username} style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }} />
                                <div>
                                    <div style={{ fontWeight: 700 }}>{p.username}</div>
                                    <div style={{ fontSize: '0.8rem', color: p.is_ready ? 'var(--primary)' : 'var(--text-muted)' }}>
                                        {p.is_importing
                                            ? `IMPORTING ${Math.min(100, Math.max(0, Math.round(p.import_progress ?? 0)))}%`
                                            : (p.is_ready ? 'READY' : 'NOT READY')}
                                    </div>
                                    {p.is_importing && (
                                        <div style={{
                                            marginTop: '8px', height: '10px', width: '100%', maxWidth: '140px',
                                            background: 'rgba(255,255,255,0.1)', borderRadius: '999px', overflow: 'hidden',
                                            boxShadow: '0 0 10px rgba(46, 242, 160, 0.2)'
                                        }}>
                                            <div style={{
                                                height: '100%', width: `${Math.min(100, Math.max(0, Math.round(p.import_progress ?? 0)))}%`,
                                                background: 'linear-gradient(90deg, #2ef2a0, #3cb8ff)',
                                                transition: 'width 0.3s ease-out'
                                            }} />
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                {isHost && p.id !== hostId && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); kickPlayer(p.id) }}
                                        style={{ color: 'var(--error)', padding: '4px' }}
                                    >
                                        <XCircle size={16} />
                                    </button>
                                )}
                                {p.id === hostId && <Crown size={16} color="#fbbf24" />}
                            </div>
                        </div>
                    ))}

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
                        <button onClick={handleDeleteClick} style={{ display: 'flex', gap: '8px', padding: '8px 16px', color: 'var(--error)', border: '1px solid var(--error)', borderRadius: '99px', alignItems: 'center', fontSize: '0.9rem' }}><LogOut size={16} /> Delete Room</button>
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
                                <><RadialProgress progress={creationProgress} size={20} strokeWidth={3} /> {loadingMsg}</>
                            ) : players.some(p => p.is_importing) ? (
                                <><RadialProgress progress={importProgress} size={20} strokeWidth={3} /> Importing playlist...</>
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
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px'
                            }}
                        >
                            {creationProgress > 0 ? (
                                <><RadialProgress progress={creationProgress} size={20} strokeWidth={3} /> STARTING...</>
                            ) : (
                                currentPlayer?.is_ready ? 'READY!' : hasImported ? 'CLICK TO READY UP' : 'SKIP IMPORT / READY'
                            )}
                        </button>
                    )}
                </div>

                {!isHost && (
                    <div style={{ textAlign: 'center', marginTop: '16px', color: 'var(--text-muted)' }}>
                        {currentPlayer?.is_ready ? 'Waiting for host...' : 'Import songs or click Ready to skip.'}
                    </div>
                )}
            </div>

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
