import { useRef, useEffect, useState } from 'react'
import { FriendStatus, useFriends } from '@/hooks/useFriends'
import { UserPlus, UserMinus, UserCheck, X } from 'lucide-react'

type UserPopoverProps = {
    targetUser: { id: string, username: string, avatar_url: string, score?: number }
    isOpen: boolean
    onClose: () => void
    currentUserProfileId?: string
    anchorPoint?: { x: number, y: number }
}

export default function UserPopover({ targetUser, isOpen, onClose, currentUserProfileId, anchorPoint }: UserPopoverProps) {
    const { getFriendStatus, sendFriendRequest, removeFriend, acceptFriendRequest } = useFriends()
    const [status, setStatus] = useState<FriendStatus>('none')
    const [loading, setLoading] = useState(false)
    const popoverRef = useRef<HTMLDivElement>(null)
    const [menuPos, setMenuPos] = useState<{ x: number, y: number }>({ x: 0, y: 0 })

    // Update status when popover opens or friends change
    useEffect(() => {
        if (isOpen) {
            setStatus(getFriendStatus(targetUser.id))
        }
    }, [isOpen, getFriendStatus, targetUser.id])

    // Click outside to close
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
                onClose()
            }
        }
        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside)
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
        }
    }, [isOpen, onClose])

    // Close on Escape
    useEffect(() => {
        if (!isOpen) return
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', handleKeyDown)
        return () => document.removeEventListener('keydown', handleKeyDown)
    }, [isOpen, onClose])

    // Position menu near click/tap and clamp to viewport
    useEffect(() => {
        if (!isOpen) return
        const fallback = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
        const initial = anchorPoint ?? fallback
        setMenuPos(initial)
    }, [isOpen, anchorPoint?.x, anchorPoint?.y])

    useEffect(() => {
        if (!isOpen) return
        const raf = requestAnimationFrame(() => {
            if (!popoverRef.current) return
            const rect = popoverRef.current.getBoundingClientRect()
            const pad = 12
            let x = menuPos.x
            let y = menuPos.y
            if (x + rect.width > window.innerWidth - pad) x = window.innerWidth - rect.width - pad
            if (y + rect.height > window.innerHeight - pad) y = window.innerHeight - rect.height - pad
            if (x < pad) x = pad
            if (y < pad) y = pad
            if (x !== menuPos.x || y !== menuPos.y) {
                setMenuPos({ x, y })
            }
        })
        return () => cancelAnimationFrame(raf)
    }, [isOpen, menuPos.x, menuPos.y])

    if (!isOpen) return null

    // Don't show options for self
    if (currentUserProfileId === targetUser.id) return null

    const handleAction = async (action: () => Promise<void>) => {
        try {
            setLoading(true)
            await action()
            // Refresh local status immediately for UI responsiveness
            setStatus(getFriendStatus(targetUser.id))
        } catch (error) {
            console.error(error)
        } finally {
            setLoading(false)
            // Optional: Close on success? Or keep open to show updated state?
            // Let's keep open so they see "Request Sent" or "Friend Added"
        }
    }

    return (
        <div
            ref={popoverRef}
            className="glass-panel"
            style={{
                width: '300px', padding: '20px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px',
                position: 'fixed',
                left: `${menuPos.x}px`,
                top: `${menuPos.y}px`,
                zIndex: 9999,
                animation: 'fadeIn 0.15s ease-out'
            }}
        >
            <button
                onClick={onClose}
                style={{ position: 'absolute', top: '10px', right: '10px', color: 'var(--text-muted)' }}
            >
                <X size={18} />
            </button>

            {/* Avatar & Name */}
            <img
                src={targetUser.avatar_url}
                alt={targetUser.username}
                style={{ width: '72px', height: '72px', borderRadius: '50%', objectFit: 'cover', border: '3px solid var(--glass-border)' }}
            />
            <div style={{ textAlign: 'center' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>{targetUser.username}</h3>
                {targetUser.score !== undefined && (
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Score: {targetUser.score}</p>
                )}
            </div>

            {/* Action Buttons */}
            <div style={{ width: '100%', marginTop: '6px' }}>
                {getFriendStatus(targetUser.id) === 'friend' && (
                    <button
                        className="btn-glass"
                        onClick={() => handleAction(() => removeFriend(targetUser.id))}
                        disabled={loading}
                        style={{
                            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                            color: 'var(--error)', borderColor: 'var(--error)'
                        }}
                    >
                        <UserMinus size={18} />
                        {loading ? 'Removing...' : 'Remove Friend'}
                    </button>
                )}

                {getFriendStatus(targetUser.id) === 'none' && (
                    <button
                        className="btn-primary"
                        onClick={() => handleAction(() => sendFriendRequest(targetUser.id))}
                        disabled={loading}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                    >
                        <UserPlus size={18} />
                        {loading ? 'Sending...' : 'Add Friend'}
                    </button>
                )}

                {getFriendStatus(targetUser.id) === 'pending_outgoing' && (
                    <button
                        className="btn-glass"
                        disabled
                        style={{
                            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                            opacity: 0.7, cursor: 'default'
                        }}
                    >
                        <UserCheck size={18} />
                        Request Sent
                    </button>
                )}
                {/* Note: We could add 'Cancel Request' here if we exposed it in hook */}

                {getFriendStatus(targetUser.id) === 'pending_incoming' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                        <div style={{ textAlign: 'center', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                            Sent you a friend request
                        </div>
                        <button
                            className="btn-primary"
                            onClick={() => handleAction(() => acceptFriendRequest(targetUser.id))}
                            disabled={loading}
                            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                        >
                            <UserPlus size={18} />
                            {loading ? 'Accepting...' : 'Accept Request'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}
