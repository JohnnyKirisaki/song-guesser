'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { User, Session } from '@supabase/supabase-js'

type Profile = {
    id: string
    username: string
    avatar_url: string
    wins: number
}

type UserContextType = {
    user: User | null
    profile: Profile | null
    isLoading: boolean
    signIn: (username: string, avatarUrl: string) => Promise<void>
    updateProfile: (data: Partial<Profile>) => Promise<void>
}

const UserContext = createContext<UserContextType | undefined>(undefined)

export function UserProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null)
    const [profile, setProfile] = useState<Profile | null>(null)
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        let mounted = true

        const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
            if (!mounted) return

            try {
                if (session?.user) {
                    setUser(session.user)
                    const success = await fetchProfile(session.user.id)
                    if (!success && event === 'SIGNED_IN') {
                        // If we signed in but profile fetch failed, we might be in a bad state
                        console.warn('[UserContext] Profile fetch failed on sign in')
                    }
                } else {
                    setUser(null)
                    setProfile(null)
                }
            } catch (err) {
                console.error('[UserContext] Error handling auth state change:', err)
            } finally {
                setIsLoading(false)
            }
        })

        return () => {
            mounted = false
            subscription.unsubscribe()
        }
    }, [])

    // Logic for duplicate handling or initial fetch is covered by onAuthStateChange which fires immediately with current session in Supabase v2
    // But sometimes it doesn't fire INITIAL_SESSION reliably in all environments? 
    // It is safer to trust the listener. We can do a manual check if we want, but usually listener is enough.
    // If we want to be extra safe:

    useEffect(() => {
        // Just fail-safe in case listener doesn't fire for some reason (rare)
        // or if it gets stuck in LOADING state
        const check = async () => {
            try {
                const { data: { session } } = await supabase.auth.getSession()
                if (!session) {
                    setIsLoading(false)
                } else {
                    // If session exists but no profile after 5s, something is wrong
                    setTimeout(() => {
                        if (mounted) setIsLoading(false)
                    }, 5000)
                }
            } catch (e) {
                setIsLoading(false)
            }
        }
        let mounted = true
        check()
        return () => { mounted = false }
    }, [])

    const fetchProfile = async (userId: string): Promise<boolean> => {
        const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single()

        if (error || !data) {
            console.warn('[UserContext] Profile not found for user, clearing session.')
            setProfile(null)
            return false
        }
        setProfile(data)
        return true
    }

    const signIn = async (username: string, avatarUrl: string) => {
        const normalizedUsername = username.toLowerCase().trim()

        // 1. Ensure we have an anonymous session first
        // If we are already signed in, check if we need to sign in again?
        // Actually, for "claim_profile" to work, we need an Auth ID.
        // If we are not signed in, sign in anonymously.
        let { data: { user } } = await supabase.auth.getUser()

        if (!user) {
            const { data: authData, error: authError } = await supabase.auth.signInAnonymously()
            if (authError) throw authError
            if (!authData.user) throw new Error('No user created')
            user = authData.user
        }

        // 2. Claim Profile via RPC
        // This handles both "Create New" and "Reclaim Existing" logic safely with RLS
        const { data: profileId, error: claimError } = await supabase.rpc('claim_profile', {
            p_username: normalizedUsername,
            p_avatar_url: avatarUrl || null
        })

        if (claimError) {
            console.error('[UserContext] Claim error:', claimError)
            throw claimError
        }

        // 3. Fetch the full profile data
        await fetchProfile(profileId)
    }

    const updateProfile = async (updates: Partial<Profile>) => {
        if (!profile) return
        const { error } = await supabase.from('profiles').update(updates).eq('id', profile.id)
        if (!error) {
            setProfile(prev => prev ? { ...prev, ...updates } : null)
        }
    }

    return (
        <UserContext.Provider value={{ user, profile, isLoading, signIn, updateProfile }}>
            {children}
        </UserContext.Provider>
    )
}

export const useUser = () => {
    const context = useContext(UserContext)
    if (context === undefined) {
        throw new Error('useUser must be used within a UserProvider')
    }
    return context
}
