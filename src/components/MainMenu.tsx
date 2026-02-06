'use client'

import { useUser } from '@/context/UserContext'
import { Trophy, Plus, LogIn, Edit2, X, ChevronLeft, Users } from 'lucide-react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { db } from '@/lib/firebase' // Firebase DB
import { ref, set, get, child } from 'firebase/database'
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
    const router = useRouter()

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
                    <Trophy size={16} color="var(--tertiary)" />
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
                <div style={{ width: '100%', maxWidth: '1100px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '32px' }}>

                    {/* Create Room Card */}
                    <button
                        onClick={handleCreateRoom}
                        disabled={loading}
                        className="glass-panel"
                        style={{
                            height: '300px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '24px',
                            transition: 'var(--transition)',
                            position: 'relative',
                            overflow: 'hidden',
                            opacity: loading ? 0.7 : 1
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.transform = 'translateY(-8px)'
                            e.currentTarget.style.borderColor = 'var(--primary)'
                            e.currentTarget.querySelector('.icon-bg')!.setAttribute('style', 'opacity: 0.2; transform: scale(1.2); transition: all 0.5s;')
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.transform = 'translateY(0)'
                            e.currentTarget.style.borderColor = 'var(--glass-border)'
                            e.currentTarget.querySelector('.icon-bg')!.setAttribute('style', 'opacity: 0.05; transform: scale(1); transition: all 0.5s;')
                        }}
                    >
                        <div className="icon-bg" style={{
                            position: 'absolute', inset: 0,
                            background: 'radial-gradient(circle, var(--primary) 0%, transparent 70%)',
                            opacity: 0.05,
                            pointerEvents: 'none'
                        }} />

                        <div style={{
                            width: '80px', height: '80px', borderRadius: '50%', background: 'rgba(46, 242, 160, 0.12)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: 'var(--primary)'
                        }}>
                            <Plus size={40} />
                        </div>
                        <div style={{ textAlign: 'center' }}>
                            <h2 style={{ fontSize: '1.8rem', marginBottom: '8px' }}>Create Room</h2>
                            <p style={{ color: 'var(--text-muted)' }}>Host a game and invite friends</p>
                        </div>
                    </button>

                    {/* Join Room Card */}
                    <button
                        onClick={() => setShowJoinModal(true)}
                        disabled={loading}
                        className="glass-panel"
                        style={{
                            height: '300px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '24px',
                            transition: 'var(--transition)'
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.transform = 'translateY(-8px)'
                            e.currentTarget.style.borderColor = 'var(--secondary)'
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.transform = 'translateY(0)'
                            e.currentTarget.style.borderColor = 'var(--glass-border)'
                        }}
                    >
                        <div style={{
                            width: '80px', height: '80px', borderRadius: '50%', background: 'rgba(60, 184, 255, 0.12)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: 'var(--secondary)'
                        }}>
                            <LogIn size={40} />
                        </div>
                        <div style={{ textAlign: 'center' }}>
                            <h2 style={{ fontSize: '1.8rem', marginBottom: '8px' }}>Join Room</h2>
                            <p style={{ color: 'var(--text-muted)' }}>Enter a code to join an existing game</p>
                        </div>
                    </button>



                </div>
            </div>

            {/* Join Modal Overlay */}
            {showJoinModal && (
                <div style={{
                    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
                    backdropFilter: 'blur(8px)', zIndex: 100,
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                    <div className="glass-panel" style={{ padding: '32px', width: '100%', maxWidth: '400px', position: 'relative' }}>
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
                        transform: isSidebarOpen ? 'translateX(0)' : 'translateX(0)',
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
                    style={{
                        width: isSidebarOpen ? '320px' : '0px',
                        height: '500px',
                        overflow: 'hidden',
                        transition: 'width 0.3s ease',
                        background: 'rgba(0, 0, 0, 0.4)',
                        backdropFilter: 'blur(16px)',
                        borderTopLeftRadius: '16px',
                        borderBottomLeftRadius: '16px',
                        borderTop: isSidebarOpen ? '1px solid var(--glass-border)' : 'none',
                        borderBottom: isSidebarOpen ? '1px solid var(--glass-border)' : 'none',
                        borderLeft: isSidebarOpen ? '1px solid var(--glass-border)' : 'none',
                        borderRight: 'none',
                    }}
                >
                    <div style={{ width: '320px', height: '100%', padding: '16px' }}>
                        <FriendList currentUserId={profile.id} minimal={true} />
                    </div>
                </div>
            </div>

            {showEditProfile && <ProfileEditor onClose={() => setShowEditProfile(false)} />}
        </div>
    )
}
