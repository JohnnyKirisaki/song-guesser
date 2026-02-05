'use client'

import { useState, useEffect } from 'react'
import { db } from '@/lib/firebase'
import { ref, push, onChildAdded, off, serverTimestamp } from 'firebase/database'

type Reaction = {
    id: string
    src: string
    x: number
    y: number
}

export default function EmoteBar({ roomCode }: { roomCode: string }) {
    const [emotes, setEmotes] = useState<string[]>([])
    const [reactions, setReactions] = useState<Reaction[]>([])

    // Load available emotes from API
    useEffect(() => {
        fetch('/api/emotes')
            .then(res => res.json())
            .then(data => {
                if (data.emotes) setEmotes(data.emotes)
            })
            .catch(err => console.error('Failed to load emotes:', err))
    }, [])

    useEffect(() => {
        const reactionsRef = ref(db, `rooms/${roomCode}/reactions`)
        const startTime = Date.now()

        // Listen for new reactions added to the room
        const unsubscribe = onChildAdded(reactionsRef, (snapshot) => {
            const data = snapshot.val()
            // Only show reactions sent AFTER we joined/loaded
            if (data && data.timestamp && data.timestamp > startTime) {
                addReaction(data.src)
            }
        })

        return () => {
            off(reactionsRef, 'child_added', unsubscribe)
        }
    }, [roomCode])

    const addReaction = (src: string) => {
        const id = Math.random().toString(36).substr(2, 9)
        const x = Math.random() * 80 + 10 // 10% to 90% width
        const y = Math.random() * 20 + 70 // 70% to 90% height

        setReactions(prev => [...prev, { id, src, x, y }])

        // Remove after animation
        setTimeout(() => {
            setReactions(prev => prev.filter(r => r.id !== id))
        }, 2000)
    }

    const sendEmote = async (src: string) => {
        // We push to Firebase, and our own listener will catch it and show it locally
        // Alternatively, show it locally instantly and then push
        // Showing locally instantly feels snappier
        addReaction(src)

        try {
            const reactionsRef = ref(db, `rooms/${roomCode}/reactions`)
            await push(reactionsRef, {
                src,
                timestamp: Date.now() // Using client side for simplicity in filtering
            })
        } catch (err) {
            console.error('Failed to send emote:', err)
        }
    }

    return (
        <>
            {/* Buttons Bar */}
            <div className="glass-panel" style={{
                position: 'fixed', right: '20px', top: '50%', transform: 'translateY(-50%)',
                padding: '16px 8px', borderRadius: '50px', display: 'flex', flexDirection: 'column', gap: '8px', zIndex: 100
            }}>
                {emotes.length === 0 && <span style={{ color: '#888', fontSize: '0.8rem' }}>No custom emotes</span>}

                {emotes.map(src => (
                    <button
                        key={src}
                        onClick={() => sendEmote(src)}
                        style={{
                            background: 'transparent', border: 'none',
                            cursor: 'pointer', transition: 'transform 0.1s',
                            padding: '4px'
                        }}
                        onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.2)'}
                        onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                    >
                        <img src={src} alt="emote" style={{ width: '32px', height: '32px', objectFit: 'contain' }} />
                    </button>
                ))}
            </div>

            {/* Floating Reactions Layer */}
            <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 99, overflow: 'hidden' }}>
                {reactions.map(r => (
                    <div
                        key={r.id}
                        style={{
                            position: 'absolute',
                            left: `${r.x}%`,
                            top: `${r.y}%`,
                            width: '48px', height: '48px',
                            animation: 'floatUp 2s ease-out forwards'
                        }}
                    >
                        <img src={r.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    </div>
                ))}
            </div>

            <style jsx global>{`
                @keyframes floatUp {
                    0% { transform: translateY(0) scale(0.5); opacity: 0; }
                    10% { opacity: 1; transform: translateY(-20px) scale(1.2); }
                    100% { transform: translateY(-200px) scale(1); opacity: 0; }
                }
            `}</style>
        </>
    )
}
