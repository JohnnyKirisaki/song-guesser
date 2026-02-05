'use client'

import React, { createContext, useContext, useEffect, useState } from 'react'
import { auth, db } from '@/lib/firebase'
import { signInAnonymously, onAuthStateChanged, User as FirebaseUser } from 'firebase/auth'
import { ref, update, get } from 'firebase/database'

type UserProfile = {
    id: string
    username: string
    avatar_url: string
    wins?: number
}

type UserContextType = {
    user: FirebaseUser | null
    profile: UserProfile | null
    isLoading: boolean
    signIn: (username: string, avatarUrl: string) => Promise<void>
    updateProfile: (updates: Partial<UserProfile>) => Promise<void>
    signOut: () => Promise<void>
}

const UserContext = createContext<UserContextType | undefined>(undefined)

export function UserProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<FirebaseUser | null>(null)
    const [profile, setProfile] = useState<UserProfile | null>(null)
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        // Listen for auth state changes
        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            setUser(currentUser)

            if (currentUser) {
                // Fetch Profile from RTDB
                const profileRef = ref(db, `profiles/${currentUser.uid}`)
                try {
                const snapshot = await get(profileRef)
                if (snapshot.exists()) {
                        const data = snapshot.val()
                        setProfile({
                            ...data,
                            wins: data.wins ?? 0
                        })
                    } else {
                        // Profile doesn't exist yet (will be created in signIn)
                        setProfile(null)
                    }
                } catch (e) {
                    console.error("Error fetching profile:", e)
                }
            } else {
                setProfile(null)
            }

            setIsLoading(false)
        })

        return () => unsubscribe()
    }, [])

    const signIn = async (username: string, avatarUrl: string) => {
        try {
            setIsLoading(true)
            let currentUser = auth.currentUser

            if (!currentUser) {
                const result = await signInAnonymously(auth)
                currentUser = result.user
            }

            const profileRef = ref(db, `profiles/${currentUser.uid}`)
            const existingSnapshot = await get(profileRef)
            const existingProfile = existingSnapshot.exists() ? existingSnapshot.val() : null

            // Save Profile to Realtime Database
            const profileData: UserProfile = {
                id: currentUser.uid,
                username,
                avatar_url: avatarUrl,
                wins: existingProfile?.wins ?? 0
            }

            await update(profileRef, profileData)

            // Save Global Username Mapping (for persistence across sessions)
            const slug = username.trim().toLowerCase()
            if (slug) {
                await update(ref(db, `usernames/${slug}`), {
                    avatar_url: avatarUrl,
                    original_name: username
                })
            }

            setProfile(profileData)

        } catch (error) {
            console.error('Login error:', error)
            throw error
        } finally {
            setIsLoading(false)
        }
    }

    const signOut = async () => {
        await auth.signOut()
        setProfile(null)
        setUser(null)
    }

    const updateProfile = async (updates: Partial<UserProfile>) => {
        const currentUser = auth.currentUser
        if (!currentUser) return
        const profileRef = ref(db, `profiles/${currentUser.uid}`)
        await update(profileRef, updates)
        setProfile(prev => prev ? { ...prev, ...updates } : prev)
    }

    return (
        <UserContext.Provider value={{ user, profile, isLoading, signIn, updateProfile, signOut }}>
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
