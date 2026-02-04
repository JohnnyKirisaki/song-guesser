'use client'

import { useState, useEffect, useCallback } from 'react'
import { useUser } from '@/context/UserContext'
import { supabase } from '@/lib/supabase'
import { Users, Clock, Music, Play, Copy, Check, Settings as SettingsIcon, Loader2, Crown } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { fetchSpotifyData, addSongsToRoom } from '@/lib/spotify'
import { initializeGame } from '@/lib/game-logic'

type Player = {
    user_id: string
    score: number
    is_ready: boolean
    profile: {
        username: string
        avatar_url: string
    }
}

type RoomSettings = {
    rounds: number
    time: number
    mode: 'normal' | 'rapid' | 'artist_only' | 'song_only'
}

export default function Lobby({ roomCode, initialSettings, isHost, hostId }: { roomCode: string, initialSettings: any, isHost: boolean, hostId: string }) {
    const { profile } = useUser()
    const router = useRouter()
    const [players, setPlayers] = useState<Player[]>([])
    const [settings, setSettings] = useState<RoomSettings>(initialSettings)
    const [spotifyLink, setSpotifyLink] = useState('')
    const [songsAdded, setSongsAdded] = useState(false)
    const [isImporting, setIsImporting] = useState(false)
    const [copied, setCopied] = useState(false)
    const [songCount, setSongCount] = useState(0)
    const [isStarting, setIsStarting] = useState(false)

    // Define fetch functions with useCallback to prevent stale closures
    const fetchPlayers = useCallback(async () => {
        // DEBUG: Check visibility without Join
        const { count: rawCount } = await supabase.from('room_players').select('*', { count: 'exact', head: true }).eq('room_code', roomCode)

        // DEBUG: Check TRUE count (Server Side)
        const { data: serverCount, error: rpcError } = await supabase.rpc('get_debug_player_count', { p_room_code: roomCode })
        const { data, error } = await supabase
            .from('room_players')
            .select('*, profile:profiles(username, avatar_url)')
            .eq('room_code', roomCode)

        if (error) {
            console.error('[Lobby] Error fetching players:', error)
            return
        }

        if (data) {
            setPlayers(data as any)
        }
    }, [roomCode])

    const fetchSongCount = useCallback(async () => {
        const { count } = await supabase
            .from('room_songs')
            .select('*', { count: 'exact', head: true })
            .eq('room_code', roomCode)

        if (count !== null) setSongCount(count)
    }, [roomCode])

    useEffect(() => {
        // Fetch initial players
        fetchPlayers()
        fetchSongCount()

        // Fallback Polling (Every 3s)
        const pollInterval = setInterval(() => {
            fetchPlayers()
            fetchSongCount()
        }, 3000)

        // Realtime Subscription
        const channel = supabase
            .channel(`room_lobby_${roomCode}`) // Unique channel name
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'room_players',
                filter: `room_code=eq.${roomCode}`
            }, (payload) => {
                // Small delay to ensure DB write propagation before read
                setTimeout(() => {
                    fetchPlayers()
                }, 500)
            })
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'rooms',
                filter: `code=eq.${roomCode}`
            }, (payload) => {
                if (payload.new.status === 'playing') {
                    router.push(`/game/${roomCode}`)
                }
                if (payload.new.settings) {
                    setSettings(payload.new.settings)
                }
            })
            .subscribe((status, err) => {
                })

        return () => {
            clearInterval(pollInterval)
            supabase.removeChannel(channel)
        }
    }, [roomCode, router, fetchPlayers, fetchSongCount])

    const copyLink = () => {
        const url = `${window.location.origin}/room/${roomCode}` // In real app, maybe dedicated join link
        navigator.clipboard.writeText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    const addSongs = async () => {
        if (!spotifyLink) return
        if (!profile) return
        if (isImporting) return

        setIsImporting(true)
        try {
            const tracks = await fetchSpotifyData(spotifyLink)
            // 1. Add songs
            await addSongsToRoom(roomCode, profile.id, tracks)
            // 2. Mark as ready
            const { error: updateError } = await supabase
                .from('room_players')
                .update({ is_ready: true, playlist_url: spotifyLink })
                .eq('room_code', roomCode)
                .eq('user_id', profile.id)

            if (updateError) {
                console.error('Error updating ready status:', updateError)
                throw updateError
            }

            setSongsAdded(true)

            // 3. Force refresh immediately
            await fetchPlayers()

        } catch (error: any) {
            console.error('Error adding songs', error)
            alert(`Failed to import songs: ${error.message}`)
        } finally {
            setIsImporting(false)
        }
    }

    const startGame = async () => {
        if (!isHost) return
        if (!allReady) {
            alert('Wait for all players to be ready!')
            return
        }
        if (isStarting) {
            return
        }

        setIsStarting(true)
        try {
            await initializeGame(roomCode, settings)
            router.push(`/game/${roomCode}`)
        } catch (error: any) {
            console.error('[Lobby] Failed to start game:', error)
            console.error('[Lobby] Error Details:', JSON.stringify(error, null, 2))
            alert(`Failed to start game: ${error.message || 'Unknown error'}`)
            setIsStarting(false)
        }
    }

    const updateSettings = async (newSettings: Partial<RoomSettings>) => {
        if (!isHost) return
        const updated = { ...settings, ...newSettings }
        setSettings(updated)
        // Debounce this in real app
        await supabase.from('rooms').update({ settings: updated }).eq('code', roomCode)
    }

    const allReady = players.length > 0 && players.every(p => p.is_ready)

    return (
        <div className="container" style={{ padding: '40px 0', maxWidth: '1000px' }}>

            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
                <div>
                    <h1 className="text-gradient" style={{ fontSize: '3rem', fontWeight: 900 }}>Room {roomCode}</h1>
                    <button
                        onClick={copyLink}
                        style={{
                            display: 'flex', alignItems: 'center', gap: '8px',
                            color: 'var(--text-muted)', marginTop: '8px',
                            padding: '8px 16px', background: 'var(--surface)', borderRadius: 'var(--radius-full)'
                        }}
                    >
                        {copied ? <Check size={16} color="var(--primary)" /> : <Copy size={16} />}
                        {copied ? 'Copied!' : 'Copy Invite Link'}
                    </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <div className="glass-panel" style={{ padding: '8px 16px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <Users size={16} /> {players.length} Players
                    </div>
                    <button
                        onClick={() => { fetchPlayers(); fetchSongCount(); }}
                        className="glass-panel"
                        style={{
                            padding: '8px 12px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            fontSize: '0.85rem',
                            color: 'var(--text-muted)',
                            transition: 'all 0.2s'
                        }}
                        title="Refresh player list"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                        </svg>
                        Refresh
                    </button>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '32px' }}>

                {/* Main Column */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

                    {/* Player List */}
                    <div className="glass-panel" style={{ padding: '24px' }}>
                        <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            Players
                        </h3>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '16px' }}>
                            {players.map(p => (
                                <div key={p.user_id} style={{ textAlign: 'center' }}>
                                    <div style={{ position: 'relative', width: '80px', height: '80px', margin: '0 auto 8px' }}>
                                        <img
                                            src={p.profile?.avatar_url || 'https://via.placeholder.com/80'}
                                            style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
                                        />
                                        {p.is_ready && (
                                            <div style={{
                                                position: 'absolute', bottom: 0, right: 0,
                                                background: 'var(--primary)', borderRadius: '50%', padding: '4px'
                                            }}>
                                                <Check size={12} color="black" />
                                            </div>
                                        )}
                                        {/* Crown for Host */}
                                        {p.user_id === hostId && (
                                            <div style={{
                                                position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)',
                                                color: '#FFD700', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))'
                                            }}>
                                                <Crown size={24} fill="#FFD700" />
                                            </div>
                                        )}
                                    </div>
                                    <div style={{ fontWeight: 600 }}>{p.profile?.username || 'Guest'}</div>
                                    {p.user_id === profile?.id && <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>(You)</span>}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Song Selection */}
                    <div className="glass-panel" style={{ padding: '24px' }}>
                        <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Music size={20} className="text-gradient" /> Your Song Selection
                        </h3>
                        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                            Paste a <b>Spotify or YouTube Playlist Link</b>.
                        </p>
                        <div style={{ display: 'flex', gap: '12px' }}>
                            <input
                                type="text"
                                placeholder="Paste Spotify or YouTube Playlist URL"
                                value={spotifyLink}
                                onChange={(e) => setSpotifyLink(e.target.value)}
                                disabled={songsAdded || isImporting}
                                style={{
                                    flex: 1, padding: '12px', borderRadius: 'var(--radius-md)',
                                    background: '#222', border: '1px solid #333', color: 'white'
                                }}
                            />
                            <button
                                onClick={addSongs}
                                className="btn-primary"
                                disabled={!spotifyLink || songsAdded || isImporting}
                                style={{ opacity: (!spotifyLink || songsAdded || isImporting) ? 0.5 : 1 }}
                            >
                                {songsAdded ? (
                                    'Ready'
                                ) : isImporting ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <Loader2 size={16} className="animate-spin" />
                                        <span>Importing</span>
                                    </div>
                                ) : (
                                    'Import'
                                )}
                            </button>
                        </div>
                        {songsAdded && (
                            <div style={{ marginTop: '10px', color: '#4ade80', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <Check size={14} /> Songs added successfully!
                            </div>
                        )}
                    </div>

                </div>

                {/* Settings Column (Right) */}
                <div className="glass-panel" style={{ padding: '24px', height: 'fit-content' }}>
                    <h3 style={{ marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <SettingsIcon size={20} /> Room Settings
                    </h3>

                    {/* Rounds */}
                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-muted)' }}>
                            Rounds
                            {songCount > 0 && (
                                <span style={{ marginLeft: '8px', fontSize: '0.8rem', color: '#888' }}>
                                    (Max: {Math.floor((2 / 3) * songCount)})
                                </span>
                            )}
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <input
                                type="range"
                                min="5"
                                max={Math.min(30, Math.max(5, Math.floor((2 / 3) * songCount)))}
                                step="1"
                                value={Math.min(settings.rounds, Math.floor((2 / 3) * songCount))}
                                onChange={(e) => updateSettings({ rounds: parseInt(e.target.value) })}
                                disabled={!isHost}
                                style={{ flex: 1, opacity: (!isHost) ? 0.5 : 1 }}
                            />
                            <span style={{ width: '40px', textAlign: 'center', fontWeight: 'bold' }}>{settings.rounds}</span>
                        </div>
                        {songCount > 0 && songCount < 15 && (
                            <div style={{ marginTop: '8px', fontSize: '0.75rem', color: '#ef4444', background: 'rgba(239, 68, 68, 0.1)', padding: '6px 10px', borderRadius: '6px' }}>
                                ⚠️ Low song count! Add more tracks for better variety.
                            </div>
                        )}
                    </div>

                    {/* Time per Round */}
                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-muted)' }}>Time (Seconds)</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <input
                                type="range" min="5" max="20" step="5"
                                value={settings.time}
                                onChange={(e) => updateSettings({ time: parseInt(e.target.value) })}
                                disabled={!isHost}
                                style={{ flex: 1, opacity: (!isHost) ? 0.5 : 1 }}
                            />
                            <span style={{ width: '30px', textAlign: 'center', fontWeight: 'bold' }}>{settings.time}s</span>
                        </div>
                    </div>

                    {/* Game Mode */}
                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-muted)' }}>Game Mode</label>
                        <div style={{ display: 'flex', gap: '8px', background: '#333', padding: '4px', borderRadius: '8px', flexWrap: 'wrap' }}>
                            {['normal', 'rapid', 'artist_only', 'song_only', 'lyrics_only'].map((mode) => (
                                <button
                                    key={mode}
                                    onClick={() => updateSettings({ mode: mode as any })}
                                    disabled={!isHost}
                                    style={{
                                        flex: 1,
                                        minWidth: '80px',
                                        padding: '8px',
                                        borderRadius: '6px',
                                        background: settings.mode === mode ? 'var(--primary)' : 'transparent',
                                        color: settings.mode === mode ? 'black' : 'white',
                                        fontWeight: settings.mode === mode ? 'bold' : 'normal',
                                        fontSize: '0.8rem',
                                        textTransform: 'capitalize',
                                        transition: 'all 0.2s',
                                        opacity: (!isHost) ? 0.5 : 1
                                    }}
                                >
                                    {mode.replace('_', ' ')}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Start Button */}
                    {isHost ? (
                        <button
                            onClick={startGame}
                            disabled={!allReady || isStarting}
                            className="btn-primary"
                            style={{
                                width: '100%',
                                padding: '16px',
                                fontSize: '1.2rem',
                                marginTop: '24px',
                                opacity: allReady ? 1 : 0.5,
                                cursor: allReady ? 'pointer' : 'not-allowed'
                            }}
                        >
                            {isStarting ? (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                                    <Loader2 className="spin" /> STARTING...
                                </div>
                            ) : allReady ? (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                                    <Play fill="black" /> START GAME
                                </div>
                            ) : (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                                    <Loader2 className="animate-spin" /> WAITING FOR PLAYERS...
                                </div>
                            )}
                        </button>
                    ) : (
                        <div style={{
                            marginTop: '24px', padding: '16px', background: '#333',
                            borderRadius: 'var(--radius-md)', textAlign: 'center', color: '#aaa'
                        }}>
                            Waiting for host to start...
                        </div>
                    )}
                </div>

            </div>
        </div>
    )
}
