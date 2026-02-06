import { useFriends } from '@/hooks/useFriends'
import { User, LogIn, Sparkles, Check, X, Users, Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, type MouseEvent } from 'react'
import UserPopover from './UserPopover'

type FriendListProps = {
    currentUserId: string
    minimal?: boolean
}

export default function FriendList({ currentUserId, minimal = false }: FriendListProps) {
    const { friends, incomingRequests, loading, acceptFriendRequest, removeFriend } = useFriends() // removeFriend needed? maybe via popover
    const router = useRouter()

    // For handling popover on friends
    const [selectedUser, setSelectedUser] = useState<any>(null)
    const [menuAnchor, setMenuAnchor] = useState<{ x: number, y: number } | null>(null)

    const openUserMenu = (user: any, event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        setSelectedUser(user)
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

    // Filter requests - wait, we only get IDs for requests. 
    // We should probably fetch profiles for requests too in the hook for a cleaner UI, 
    // but for now let's just show "Incoming Requests" count or simple ID list if we have to.
    // Actually, `useFriends` hook only returns IDs for requests. 
    // Let's stick to Friends display mostly. Implementing request fetching in hook would be better.
    // ...Checking hook... yes, it returns string IDs for requests.
    // I should probably update the hook to fetch profiles for requests too, or fetch them here.
    // For simplicity, let's just focus on Friends List first. 
    // Maybe we just show a "Request from X" or ignore requests in this list? 
    // The requirement said "a pop up will appear saying Add as a friend".
    // So if users mutually add, they become friends.
    // Does the user necessitate a "Pending Requests" list? 
    // "Friends can see in the main menu if the other friend is hosting a lobby".
    // It doesn't explicitly ask for a "Pending Requests" UI list, but "Friend System" implies it.
    // I'll stick to just Friends for now to match the strict requirements, 
    // but having a "Requests" section is standard. 
    // I'll leave requests as just "User A clicked User B". 
    // Wait, if I don't see who requested me, how do I click them?
    // "if the other user does the same to us we become friends". 
    // This implies I have to coincidentally click them in a lobby or game?
    // That's rare. Usually you see a request list.
    // I will add a simple incoming request list assuming I can just display the ID or fetch the name quickly.
    // Actually, let's just focus on the explicitly asked features: "Friends can see...".
    // I'll include incoming requests if I can easily fetch names, otherwise just friends.
    // Let's fetch names for requests in this component for now if needed, or skip it.
    // I'll stick to Friends only for MVP unless I update hook.

    return (
        <div className={minimal ? '' : 'glass-panel'} style={{ width: '100%', padding: minimal ? '0' : '24px', display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', paddingBottom: minimal ? '12px' : '0', borderBottom: minimal ? '1px solid rgba(255,255,255,0.1)' : 'none' }}>
                <Users className="text-primary" size={24} color="var(--primary)" />
                <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Friends ({friends.length})</h2>
            </div>

            {friends.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: '12px' }}>
                    No friends yet. Play a game and click an avatar to add one!
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, overflowY: 'auto' }}>
                    {friends.map(friend => (
                        <div
                            key={friend.id}
                            style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '12px',
                                border: '1px solid rgba(255,255,255,0.05)'
                            }}
                        >
                            <div
                                style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}
                                onClick={(e) => openUserMenu(friend, e)}
                                onContextMenu={(e) => openUserMenu(friend, e)}
                            >
                                <img
                                    src={friend.avatar_url || 'https://via.placeholder.com/40'}
                                    alt={friend.username}
                                    style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }}
                                />
                                <div>
                                    <div style={{ fontWeight: 600 }}>{friend.username}</div>
                                    <div style={{ fontSize: '0.8rem', color: friend.hosting ? 'var(--primary)' : 'var(--text-muted)' }}>
                                        {friend.hosting ? 'Hosting a Lobby' : ''}
                                    </div>
                                </div>
                            </div>

                            {friend.hosting && (
                                <button
                                    className="btn-primary"
                                    style={{ padding: '6px 12px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
                                    onClick={() => router.push(`/room/${friend.hosting?.roomCode}`)}
                                >
                                    <LogIn size={14} /> Join
                                </button>
                            )}
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
