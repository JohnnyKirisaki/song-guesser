'use client'

import { useUser } from '@/context/UserContext'
import { Trophy, Plus, LogIn, Edit2, X, ChevronLeft, Users, ArrowRight } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { db } from '@/lib/firebase' // Firebase DB
import { ref, set, get, child, update } from 'firebase/database'
import { generateRoomCode } from '@/lib/game-utils'
import ProfileEditor from '@/components/ProfileEditor'
import FriendList from '@/components/FriendList'

export default function MainMenu({ onCreateRoom, onJoinRoom }: {
    onCreateRoom: () => void,
    onJoinRoom: () => void
}) {
    const { profile } = useUser()
    const [isHoveringProfile, setIsHoveringProfile] = useState(false)
    const [showJoinModal, setShowJoinModal] = useState(false)
    const [showEditProfile, setShowEditProfile] = useState(false)
    const [joinCode, setJoinCode] = useState('')
    const [loading, setLoading] = useState(false)
    const [isSidebarOpen, setIsSidebarOpen] = useState(false)
    const [isMobile, setIsMobile] = useState(false)
    const [activeGame, setActiveGame] = useState<{ code: string } | null>(null)
    const router = useRouter()

    useEffect(() => {
        const check = () => setIsMobile(window.innerWidth <= 768)
        check()
        window.addEventListener('resize', check)
        return () => window.removeEventListener('resize', check)
    }, [])

    // Check for an active game in localStorage and verify it's still running
    useEffect(() => {
        const stored = localStorage.getItem('bb_active_game')
        if (!stored) return
        try {
            const { code: storedCode, joinedAt } = JSON.parse(stored)
            // Ignore stale entries older than 4 hours
            if (Date.now() - joinedAt > 4 * 60 * 60 * 1000) {
                localStorage.removeItem('bb_active_game')
                return
            }
            get(ref(db, `rooms/${storedCode}/status`)).then(snap => {
                if (snap.exists() && snap.val() === 'playing') {
                    setActiveGame({ code: storedCode })
                } else {
                    localStorage.removeItem('bb_active_game')
                }
            })
        } catch {
            localStorage.removeItem('bb_active_game')
        }
    }, [])

    if (!profile) return null

    const handleCreateRoom = async () => {
        try {
            setLoading(true)

            // Generate Code
            const code = generateRoomCode()

            // Create Room in Firebase
            // Structure: /rooms/{code}
            const roomData = {
                code,
                host_id: profile.id,
                status: 'waiting',
                created_at: new Date().toISOString(),
                settings: { rounds: 10, time: 15, mode: 'normal' },
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

            await set(ref(db, 'rooms/' + code), roomData)

            router.push(`/room/${code}`)
        } catch (error) {
            console.error('Error creating room:', error)
            alert('Failed to create room')
        } finally {
            setLoading(false)
        }
    }

    const handleJoinRoom = async (e?: React.FormEvent) => {
        e?.preventDefault()
        if (!joinCode) return

        try {
            setLoading(true)
            const code = joinCode.toUpperCase()

            // Check existence in Firebase
            const snapshot = await get(child(ref(db), `rooms/${code}`))

            if (!snapshot.exists()) {
                alert('Room not found')
                return
            }

            // We just redirect. The Lobby component will handle adding the user to "players" list.
            router.push(`/room/${code}`)

        } catch (error) {
            console.error('Error joining room:', error)
            alert('Failed to join room')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>

            {/* Top Bar */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '24px',
                width: '100%'
            }}>
                {/* Stats (Top Left) */}
                <div className="glass-panel" style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Trophy size={16} color="#FFD700" />
                    <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{profile.wins ?? 0} Wins</span>
                </div>

                {/* Profile (Top Right) */}
                <div
                    className="glass-panel"
                    style={{
                        padding: '4px 4px 4px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        cursor: 'pointer',
                        transition: 'var(--transition)',
                        background: isHoveringProfile ? 'rgba(255,255,255,0.15)' : 'var(--glass)'
                    }}
                    onClick={() => setShowEditProfile(true)}
                >
                    <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Welcome</div>
                        <div style={{ fontWeight: 700 }}>{profile.username}</div>
                    </div>
                    <div style={{ position: 'relative', width: '40px', height: '40px' }}>
                        <img
                            src={profile.avatar_url || 'https://via.placeholder.com/40'}
                            alt="Profile"
                            style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
                        />
                        <div style={{
                            position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            opacity: isHoveringProfile ? 1 : 0, transition: 'opacity 0.2s', borderRadius: '50%'
                        }}>
                            <Edit2 size={16} color="white" />
                        </div>
                    </div>
                </div>
            </div>

            {/* Center Content */}
            <div className="container" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: '100%', maxWidth: '1100px', display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(280px, 1fr))', gap: isMobile ? '16px' : '32px' }}>

                    {/* Shared card style */}
                    {(() => {
                        const cardStyle: React.CSSProperties = {
                            height: isMobile ? '120px' : '260px',
                            display: 'flex',
                            flexDirection: isMobile ? 'row' : 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: isMobile ? '16px' : '22px',
                            padding: isMobile ? '0 24px' : '32px 28px',
                            transition: 'var(--transition)',
                            position: 'relative',
                            overflow: 'hidden',
                        }
                        const iconStyle = (bg: string): React.CSSProperties => ({
                            width: isMobile ? '48px' : '72px',
                            height: isMobile ? '48px' : '72px',
                            borderRadius: '50%',
                            background: bg,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                        })
                        const textStyle: React.CSSProperties = {
                            width: '100%',
                            maxWidth: isMobile ? 'none' : '240px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: isMobile ? 'flex-start' : 'center',
                            justifyContent: 'flex-start',
                            textAlign: isMobile ? 'left' : 'center',
                            flexShrink: 0,
                            minHeight: isMobile ? 'auto' : '78px',
                        }
                        const titleStyle: React.CSSProperties = {
                            fontSize: isMobile ? '1.2rem' : '1.6rem',
                            fontWeight: 700,
                            margin: '0 0 8px 0',
                            lineHeight: 1.2,
                        }
                        const subtitleStyle: React.CSSProperties = {
                            color: 'var(--text-muted)',
                            fontSize: isMobile ? '0.82rem' : '0.95rem',
                            margin: 0,
                            lineHeight: 1.3,
                        }

                        return (
                            <>
                                {/* Continue Game Card — only shown if active game detected */}
                                {activeGame && (
                                    <button
                                        onClick={() => router.push(`/room/${activeGame.code}`)}
                                        className="glass-panel"
                                        style={{ ...cardStyle, borderColor: 'rgba(29, 185, 84, 0.4)', borderTopColor: 'rgba(29, 185, 84, 0.6)' }}
                                        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-8px)'; e.currentTarget.style.borderColor = 'var(--primary)' }}
                                        onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = 'rgba(29, 185, 84, 0.4)' }}
                                    >
                                        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle, rgba(29,185,84,0.12) 0%, transparent 70%)', pointerEvents: 'none' }} />
                                        <div style={iconStyle('rgba(29, 185, 84, 0.15)')}>
                                            <ArrowRight size={isMobile ? 24 : 36} color="var(--primary)" />
                                        </div>
                                        <div style={textStyle}>
                                            <h2 style={{ ...titleStyle, color: 'var(--primary)' }}>Continue Game</h2>
                                            <p style={subtitleStyle}>Room {activeGame.code} is still active</p>
                                        </div>
                                    </button>
                                )}

                                {/* Create Room Card */}
                                <button
                                    onClick={handleCreateRoom}
                                    disabled={loading}
                                    className="glass-panel"
                                    style={{ ...cardStyle, opacity: loading ? 0.7 : 1 }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.transform = 'translateY(-8px)'
                                        e.currentTarget.style.borderColor = 'var(--primary)'
                                        e.currentTarget.querySelector('.icon-bg')!.setAttribute('style', 'opacity: 0.18; transform: scale(1.2); transition: all 0.5s;')
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.transform = 'translateY(0)'
                                        e.currentTarget.style.borderColor = 'var(--glass-border)'
                                        e.currentTarget.querySelector('.icon-bg')!.setAttribute('style', 'opacity: 0.05; transform: scale(1); transition: all 0.5s;')
                                    }}
                                >
                                    <div className="icon-bg" style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle, var(--primary) 0%, transparent 70%)', opacity: 0.05, pointerEvents: 'none' }} />
                                    <div style={iconStyle('rgba(46, 242, 160, 0.12)')}>
                                        <Plus size={isMobile ? 24 : 36} color="var(--primary)" />
                                    </div>
                                    <div style={textStyle}>
                                        <h2 style={titleStyle}>Create Room</h2>
                                        <p style={subtitleStyle}>Host a game and invite friends</p>
                                    </div>
                                </button>

                                {/* Join Room Card */}
                                <button
                                    onClick={() => setShowJoinModal(true)}
                                    disabled={loading}
                                    className="glass-panel"
                                    style={cardStyle}
                                    onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-8px)'; e.currentTarget.style.borderColor = 'var(--secondary)' }}
                                    onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = 'var(--glass-border)' }}
                                >
                                    <div style={iconStyle('rgba(60, 184, 255, 0.12)')}>
                                        <LogIn size={isMobile ? 24 : 36} color="var(--secondary)" />
                                    </div>
                                    <div style={textStyle}>
                                        <h2 style={titleStyle}>Join Room</h2>
                                        <p style={subtitleStyle}>Enter a code to join a room</p>
                                    </div>
                                </button>
                            </>
                        )
                    })()}



                </div>
            </div>

            {/* Join Modal Overlay */}
            {showJoinModal && (
                <div style={{
                    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
                    backdropFilter: 'blur(8px)', zIndex: 100,
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                    <div className="glass-panel" style={{ padding: '24px', width: '100%', maxWidth: '400px', position: 'relative', margin: '0 16px' }}>
                        <button
                            onClick={() => setShowJoinModal(false)}
                            style={{ position: 'absolute', top: '16px', right: '16px', color: 'var(--text-muted)' }}
                        >
                            <X size={24} />
                        </button>

                        <h2 style={{ marginBottom: '24px', textAlign: 'center' }}>Enter Room Code</h2>
                        <form onSubmit={handleJoinRoom}>
                            <input
                                autoFocus
                                type="text"
                                value={joinCode}
                                onChange={(e) => setJoinCode(e.target.value)}
                                placeholder="e.g. A1B2C3"
                                className="ui-input"
                                style={{
                                    fontSize: '1.5rem', textAlign: 'center', letterSpacing: '4px',
                                    marginBottom: '24px', textTransform: 'uppercase'
                                }}
                            />
                            <button type="submit" className="btn-primary" style={{ width: '100%' }}>
                                {loading ? 'Joining...' : 'Join Game'}
                            </button>
                        </form>
                    </div>
                </div>
            )}


            {/* Friend List Sidebar */}
            {isMobile ? (
                // Mobile: tap-toggle overlay
                <>
                    <button
                        onClick={() => setIsSidebarOpen(v => !v)}
                        className="glass-panel"
                        style={{
                            position: 'fixed', bottom: '20px', left: '20px',
                            zIndex: 60, padding: '12px 16px',
                            display: 'flex', alignItems: 'center', gap: '8px',
                            borderRadius: '999px', background: 'rgba(0,0,0,0.7)',
                            backdropFilter: 'blur(12px)'
                        }}
                    >
                        <Users size={18} color="var(--primary)" />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Friends</span>
                    </button>
                    {isSidebarOpen && (
                        <div style={{
                            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
                            backdropFilter: 'blur(8px)', zIndex: 55,
                            display: 'flex', alignItems: 'flex-end', justifyContent: 'center'
                        }} onClick={() => setIsSidebarOpen(false)}>
                            <div
                                className="glass-panel"
                                style={{
                                    width: '100%', maxWidth: '480px', height: '70vh',
                                    borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
                                    padding: '16px', overflowY: 'auto'
                                }}
                                onClick={e => e.stopPropagation()}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                    <h3 style={{ fontWeight: 700 }}>Friends</h3>
                                    <button onClick={() => setIsSidebarOpen(false)}><X size={20} /></button>
                                </div>
                                <FriendList currentUserId={profile.id} minimal={true} />
                            </div>
                        </div>
                    )}
                </>
            ) : (
                // Desktop: hover-based slide-in
                <div
                    style={{
                        position: 'fixed',
                        right: 0,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        zIndex: 50,
                        display: 'flex',
                        alignItems: 'center'
                    }}
                    onMouseEnter={() => setIsSidebarOpen(true)}
                    onMouseLeave={() => setIsSidebarOpen(false)}
                >
                    {/* Trigger Tab */}
                    <div
                        className="glass-panel"
                        style={{
                            padding: '12px 4px',
                            borderTopRightRadius: '12px',
                            borderBottomRightRadius: '12px',
                            borderLeft: 'none',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '8px',
                            transition: 'transform 0.3s ease',
                            background: 'rgba(0, 0, 0, 0.6)',
                            backdropFilter: 'blur(12px)'
                        }}
                    >
                        <ChevronLeft size={20} style={{ transform: isSidebarOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.3s' }} />
                        <Users size={16} color="var(--primary)" />
                    </div>

                    {/* Content Panel */}
                    <div
                        className="glass-panel"
                        style={{
                            width: isSidebarOpen ? '320px' : '0px',
                            height: '500px',
                            overflow: 'hidden',
                            transition: 'all 0.3s ease',
                            borderTopLeftRadius: '16px',
                            borderBottomLeftRadius: '16px',
                            borderTopRightRadius: '0',
                            borderBottomRightRadius: '0',
                            borderRight: 'none',
                            borderWidth: isSidebarOpen ? '1px' : '0px',
                            opacity: isSidebarOpen ? 1 : 0
                        }}
                    >
                        <div style={{ width: '320px', height: '100%', padding: '16px' }}>
                            <FriendList currentUserId={profile.id} minimal={true} />
                        </div>
                    </div>
                </div>
            )}

            {showEditProfile && <ProfileEditor onClose={() => setShowEditProfile(false)} />}
        </div>
    )
}
