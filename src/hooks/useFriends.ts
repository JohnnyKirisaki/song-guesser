import { useEffect, useState } from 'react'
import { useUser } from '@/context/UserContext'
import { db } from '@/lib/firebase'
import { ref, onValue, update, get, serverTimestamp } from 'firebase/database'

export type FriendStatus = 'none' | 'friend' | 'pending_incoming' | 'pending_outgoing'

export type FriendUser = {
    id: string
    username?: string
    avatar_url?: string
    status: FriendStatus
    hosting?: {
        roomCode: string
        created_at: number
    }
}

export function useFriends() {
    const { profile } = useUser()
    const [friends, setFriends] = useState<FriendUser[]>([])
    const [incomingRequests, setIncomingRequests] = useState<string[]>([])
    const [outgoingRequests, setOutgoingRequests] = useState<string[]>([])
    const [loading, setLoading] = useState(true)

    // Internal state for two-step loading
    const [friendIds, setFriendIds] = useState<string[]>([])

    // 1. Listen for Friend IDs and Requests
    useEffect(() => {
        if (!profile) {
            setFriendIds([])
            setFriends([])
            setIncomingRequests([])
            setOutgoingRequests([])
            setLoading(false)
            return
        }

        const friendsRef = ref(db, `friends/${profile.id}`)
        const requestsRef = ref(db, `friend_requests/${profile.id}`)

        // Listen for Friends (IDs)
        const unsubFriends = onValue(friendsRef, (snapshot) => {
            const data = snapshot.val() || {}
            const ids = Object.keys(data)
            setFriendIds(ids)
            // If no friends, stop loading immediately
            if (ids.length === 0) {
                setFriends([])
                setLoading(false)
            }
        })

        // Listen for Requests
        const unsubRequests = onValue(requestsRef, (snapshot) => {
            const data = snapshot.val() || {}
            setIncomingRequests(Object.keys(data.incoming || {}))
            setOutgoingRequests(Object.keys(data.outgoing || {}))
        })

        return () => {
            unsubFriends()
            unsubRequests()
        }
    }, [profile])


    // 2. Fetch Friend Details & Listen for Status Updates
    useEffect(() => {
        if (friendIds.length === 0) {
            return
        }

        setLoading(true)
        const listeners: (() => void)[] = []
        const friendsMap = new Map<string, FriendUser>()
        let updateTimer: NodeJS.Timeout | null = null

        const broadcastUpdate = () => {
            if (updateTimer) clearTimeout(updateTimer)
            updateTimer = setTimeout(() => {
                // Convert Map to Array
                // We maintain order based on friendIds if possible, or just Map values
                // friendIds is the source of truth for "who is a friend"
                const list = friendIds.map(fid => friendsMap.get(fid)).filter(Boolean) as FriendUser[]
                setFriends(list)
                setLoading(false)
            }, 50)
        }

        friendIds.forEach(fid => {
            // A. Fetch Profile (One-time check)
            // We assume username/avatar doesn't change frequently enough to need a listener
            // (Optimization to reduce active listeners)
            get(ref(db, `profiles/${fid}`)).then(pSnap => {
                const pData = pSnap.val()
                const baseUser = {
                    id: fid,
                    username: pData?.username || 'Unknown',
                    avatar_url: pData?.avatar_url || '',
                    status: 'friend'
                } as FriendUser

                // Store base
                const existing = friendsMap.get(fid)
                friendsMap.set(fid, { ...baseUser, ...(existing?.hosting ? { hosting: existing.hosting } : {}) })
                broadcastUpdate()

                // B. Listen to Hosting Status (Real-time)
                const hostingRef = ref(db, `users/${fid}/hosting`)
                const unsubHosting = onValue(hostingRef, (hSnap) => {
                    const hostingData = hSnap.val()
                    const current = friendsMap.get(fid)
                    if (current) {
                        friendsMap.set(fid, { ...current, hosting: hostingData })
                        broadcastUpdate()
                    }
                })
                listeners.push(unsubHosting)
            })
        })

        return () => {
            listeners.forEach(unsub => unsub())
            if (updateTimer) clearTimeout(updateTimer)
        }
    }, [friendIds]) // Re-run if friend list changes (add/remove)


    const getFriendStatus = (targetUserId: string): FriendStatus => {
        if (friends.some(f => f.id === targetUserId)) return 'friend'
        if (incomingRequests.includes(targetUserId)) return 'pending_incoming'
        if (outgoingRequests.includes(targetUserId)) return 'pending_outgoing'
        return 'none'
    }

    const sendFriendRequest = async (targetUserId: string) => {
        if (!profile) return

        if (incomingRequests.includes(targetUserId)) {
            await acceptFriendRequest(targetUserId)
            return
        }

        const updates: Record<string, any> = {}
        updates[`friend_requests/${profile.id}/outgoing/${targetUserId}`] = serverTimestamp()
        updates[`friend_requests/${targetUserId}/incoming/${profile.id}`] = serverTimestamp()

        await update(ref(db), updates)
    }

    const acceptFriendRequest = async (targetUserId: string) => {
        if (!profile) return

        const updates: Record<string, any> = {}
        updates[`friends/${profile.id}/${targetUserId}`] = serverTimestamp()
        updates[`friends/${targetUserId}/${profile.id}`] = serverTimestamp()

        updates[`friend_requests/${profile.id}/incoming/${targetUserId}`] = null
        updates[`friend_requests/${profile.id}/outgoing/${targetUserId}`] = null
        updates[`friend_requests/${targetUserId}/outgoing/${profile.id}`] = null
        updates[`friend_requests/${targetUserId}/incoming/${profile.id}`] = null

        await update(ref(db), updates)
    }

    const removeFriend = async (targetUserId: string) => {
        if (!profile) return

        const updates: Record<string, any> = {}
        updates[`friends/${profile.id}/${targetUserId}`] = null
        updates[`friends/${targetUserId}/${profile.id}`] = null

        // Cleanup requests
        updates[`friend_requests/${profile.id}/incoming/${targetUserId}`] = null
        updates[`friend_requests/${profile.id}/outgoing/${targetUserId}`] = null
        updates[`friend_requests/${targetUserId}/incoming/${profile.id}`] = null
        updates[`friend_requests/${targetUserId}/outgoing/${profile.id}`] = null

        await update(ref(db), updates)
    }

    return {
        friends,
        incomingRequests,
        outgoingRequests,
        loading,
        getFriendStatus,
        sendFriendRequest,
        acceptFriendRequest,
        removeFriend
    }
}
