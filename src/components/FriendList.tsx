import { useFriends, type FriendUser } from '@/hooks/useFriends'
import { LogIn, Users, Loader2, Flame, UserPlus, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, type MouseEvent } from 'react'
import UserPopover from './UserPopover'

function getStreakColor(count: number): string {
    if (!count || count <= 0) return '#555'
    if (count >= 100) return '#3EB489'
    // 3-stop: day 1 = red-orange, day 50 = purple, day 100 = mint green
    const stops = [
        { r: 255, g: 69, b: 0 },   // #FF4500
        { r: 138, g: 43, b: 226 }, // #8A2BE2
        { r: 62, g: 180, b: 137 }, // #3EB489
    ]
    let t: number, c1: typeof stops[0], c2: typeof stops[0]
    if (count <= 50) {
        t = (count - 1) / 49
        c1 = stops[0]; c2 = stops[1]
    } else {
        t = (count - 50) / 50
        c1 = stops[1]; c2 = stops[2]
    }
    const r = Math.round(c1.r + (c2.r - c1.r) * t)
    const g = Math.round(c1.g + (c2.g - c1.g) * t)
    const b = Math.round(c1.b + (c2.b - c1.b) * t)
    return `rgb(${r},${g},${b})`
}

type FriendListProps = {
    currentUserId: string
    minimal?: boolean
}

type FriendItem = {
    id: string
    username: string
    avatar_url: string
    is_online?: boolean
    hosting?: { roomCode: string } | null
    streak?: number
}

export default function FriendList({ currentUserId, minimal = false }: FriendListProps) {
    const { friends, incomingRequestProfiles, acceptFriendRequest, removeFriend, loading } = useFriends()
    const router = useRouter()

    // For handling popover on friends
    const [selectedUser, setSelectedUser] = useState<FriendItem | null>(null)
    const [menuAnchor, setMenuAnchor] = useState<{ x: number, y: number } | null>(null)

    const openUserMenu = (user: FriendUser, event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        setSelectedUser({
            id: user.id,
            username: user.username || 'Unknown',
            avatar_url: user.avatar_url || '',
            is_online: user.is_online,
            hosting: user.hosting ? { roomCode: user.hosting.roomCode } : null,
            streak: user.streak,
        })
        setMenuAnchor({ x: event.clientX, y: event.clientY })
    }

    const closeUserMenu = () => {
        setSelectedUser(null)
        setMenuAnchor(null)
    }

    if (loading) {
        return (
            <div className="glass-panel" style={{ padding: '24px', flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Loader2 className="animate-spin" color="var(--text-muted)" />
            </div>
        )
    }

    const handleDecline = async (uid: string) => {
        // Declining = removing the request (same as removeFriend cleans up requests)
        await removeFriend(uid)
    }

    return (
        <div className={minimal ? '' : 'glass-panel'} style={{ width: '100%', padding: minimal ? '0' : '24px', display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', paddingBottom: minimal ? '12px' : '0', borderBottom: minimal ? '1px solid var(--glass-border)' : 'none' }}>
                <Users className="text-primary" size={24} color="var(--primary)" />
                <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Friends ({friends.length})</h2>
            </div>

            {/* Incoming Friend Requests */}
            {incomingRequestProfiles.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Requests ({incomingRequestProfiles.length})
                    </div>
                    {incomingRequestProfiles.map(req => (
                        <div
                            key={req.id}
                            className="glass-panel"
                            style={{
                                display: 'flex', alignItems: 'center', gap: '12px',
                                padding: '10px 14px', borderRadius: '14px', boxShadow: 'none',
                                borderColor: 'rgba(96, 165, 250, 0.2)',
                            }}
                        >
                            <img
                                src={req.avatar_url || 'https://via.placeholder.com/36'}
                                alt={req.username}
                                style={{ width: '36px', height: '36px', borderRadius: '50%', objectFit: 'cover' }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{req.username}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Wants to be friends</div>
                            </div>
                            <div style={{ display: 'flex', gap: '6px' }}>
                                <button
                                    className="btn-primary"
                                    style={{ padding: '5px 12px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                                    onClick={() => acceptFriendRequest(req.id)}
                                >
                                    <UserPlus size={13} /> Accept
                                </button>
                                <button
                                    className="btn-glass"
                                    style={{ padding: '5px 10px', fontSize: '0.75rem', color: 'var(--error)' }}
                                    onClick={() => handleDecline(req.id)}
                                >
                                    <X size={13} />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {friends.length === 0 ? (
                <div className="empty-state-card">
                    <div className="empty-state-icon">
                        <Users size={26} />
                    </div>
                    <div className="empty-state-title">No friends yet</div>
                    <div style={{ maxWidth: '240px', lineHeight: 1.55 }}>
                        Play a game and click an avatar to start building your crew.
                    </div>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, overflowY: 'auto' }}>
                    {[...friends].sort((a, b) => {
                        if (a.is_online && !b.is_online) return -1
                        if (!a.is_online && b.is_online) return 1
                        return (a.username || '').localeCompare(b.username || '')
                    }).map(friend => (
                        <div
                            key={friend.id}
                            className="glass-panel"
                            style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                padding: '12px 16px', borderRadius: '16px',
                                boxShadow: 'none',
                                opacity: friend.is_online ? 1 : 0.6
                            }}
                        >
                            <div
                                style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}
                                onClick={(e) => openUserMenu(friend, e)}
                                onContextMenu={(e) => openUserMenu(friend, e)}
                            >
                                <div style={{ position: 'relative' }}>
                                    <img
                                        src={friend.avatar_url || 'https://via.placeholder.com/40'}
                                        alt={friend.username}
                                        style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover', filter: friend.is_online ? 'none' : 'grayscale(100%)' }}
                                    />
                                    {friend.is_online && (
                                        <div style={{
                                            position: 'absolute', bottom: 0, right: 0, width: '12px', height: '12px',
                                            background: '#2ef2a0', borderRadius: '50%', border: '2px solid #111'
                                        }} />
                                    )}
                                </div>
                                <div>
                                    <div style={{ fontWeight: 600 }}>{friend.username}</div>
                                    <div style={{ fontSize: '0.8rem', color: friend.hosting ? 'var(--primary)' : 'var(--text-muted)' }}>
                                        {friend.hosting ? 'Hosting a Lobby' : (friend.is_online ? 'Online' : 'Offline')}
                                    </div>
                                </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                {/* Streak flame */}
                                {(() => {
                                    const count = friend.streak || 0
                                    const color = getStreakColor(count)
                                    return (
                                        <div
                                            title={count > 0 ? `${count} day streak!` : 'No streak yet'}
                                            style={{ display: 'flex', alignItems: 'center', gap: '3px', opacity: count > 0 ? 1 : 0.35 }}
                                        >
                                            {count > 0 && (
                                                <span style={{ fontSize: '0.75rem', fontWeight: 700, color }}>
                                                    {count}
                                                </span>
                                            )}
                                            <Flame
                                                size={18}
                                                color={color}
                                                style={{ filter: count > 0 ? `drop-shadow(0 0 4px ${color})` : 'none' }}
                                            />
                                        </div>
                                    )
                                })()}
                                {friend.hosting && (
                                    <button
                                        className="btn-primary"
                                        style={{ padding: '6px 16px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
                                        onClick={() => router.push(`/room/${friend.hosting?.roomCode}`)}
                                    >
                                        <LogIn size={14} /> Join
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Popover Logic */}
            {selectedUser && (
                <UserPopover
                    isOpen={!!selectedUser}
                    targetUser={selectedUser}
                    onClose={closeUserMenu}
                    currentUserProfileId={currentUserId}
                    anchorPoint={menuAnchor || undefined}
                />
            )}
        </div>
    )
}
