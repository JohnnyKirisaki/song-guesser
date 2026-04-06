'use client'

import { useState, useEffect, useRef } from 'react'
import { Smile, ChevronUp } from 'lucide-react'
import { db } from '@/lib/firebase'
import { ref, push, onChildAdded, serverTimestamp } from 'firebase/database'

type Reaction = {
    id: string
    src: string
    x: number
    y: number
}

export default function EmoteBar({ roomCode }: { roomCode: string }) {
    const [emotes, setEmotes] = useState<string[]>([])
    const [reactions, setReactions] = useState<Reaction[]>([])
    const [tappedEmote, setTappedEmote] = useState<string | null>(null)
    const lastAddAtRef = useRef(0)
    const [isMobile, setIsMobile] = useState(false)
    const [collapsed, setCollapsed] = useState(false)

    const MAX_REACTIONS = 40
    const MIN_REACTION_INTERVAL_MS = 50

    useEffect(() => {
        const check = () => setIsMobile(window.innerWidth <= 768)
        check()
        window.addEventListener('resize', check)
        return () => window.removeEventListener('resize', check)
    }, [])

    // Load available emotes from API
    useEffect(() => {
        console.log('[EmoteBar] Mounted for room:', roomCode)
        fetch('/api/emotes')
            .then(res => res.json())
            .then(data => {
                if (data.emotes) {
                    console.log('[EmoteBar] Loaded emotes:', data.emotes.length)
                    setEmotes(data.emotes)
                }
            })
            .catch(err => console.error('[EmoteBar] Failed to load emotes:', err))
    }, [roomCode])

    function addReaction(src: string) {
        const now = Date.now()
        if (now - lastAddAtRef.current < MIN_REACTION_INTERVAL_MS) return
        lastAddAtRef.current = now

        const id = Math.random().toString(36).substr(2, 9)
        const x = Math.random() * 80 + 10 // 10% to 90% width
        const y = Math.random() * 20 + 70 // 70% to 90% height

        setReactions(prev => {
            const next = [...prev, { id, src, x, y }]
            if (next.length > MAX_REACTIONS) {
                return next.slice(next.length - MAX_REACTIONS)
            }
            return next
        })

        // Remove after animation
        setTimeout(() => {
            setReactions(prev => prev.filter(r => r.id !== id))
        }, 2000)
    }

    useEffect(() => {
        if (!roomCode) return

        const reactionsRef = ref(db, `rooms/${roomCode}/reactions`)
        const startTime = Date.now()
        console.log('[EmoteBar] Subscribing to reactions at', startTime)

        const unsubscribe = onChildAdded(reactionsRef, (snapshot) => {
            const data = snapshot.val()
            if (data && typeof data.timestamp === 'number' && data.timestamp > (startTime - 1000)) {
                addReaction(data.src)
            }
        })

        return () => {
            console.log('[EmoteBar] Unsubscribing from reactions')
            unsubscribe()
        }
    }, [roomCode])

    const sendEmote = async (src: string) => {
        console.log('[EmoteBar] Sending emote:', src)
        setTappedEmote(src)
        setTimeout(() => {
            setTappedEmote(current => current === src ? null : current)
        }, 220)
        // Show locally instantly for responsiveness
        addReaction(src)

        try {
            const reactionsRef = ref(db, `rooms/${roomCode}/reactions`)
            await push(reactionsRef, {
                src,
                timestamp: serverTimestamp()
            })
        } catch (err) {
            console.error('[EmoteBar] Failed to push emote:', err)
        }
    }

    return (
        <>
            {/* Collapsed: emoji icon button (like volume). Expanded: full emote pill */}
            {collapsed ? (
                <button
                    onClick={() => setCollapsed(false)}
                    className="glass-panel"
                    title="Show emotes"
                    style={{
                        position: 'fixed', right: '20px', top: '50%', transform: 'translateY(-50%)',
                        zIndex: 100, width: '44px', height: '44px', borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', border: '1px solid var(--glass-border)',
                        color: 'var(--text-muted)', padding: '0',
                        transition: 'background 0.2s, color 0.2s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(255,255,255,0.1)' }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = '' }}
                >
                    <Smile size={20} />
                </button>
            ) : (
                <div
                    className={`glass-panel${isMobile ? ' emote-bar-mobile' : ''}`}
                    style={{
                        position: 'fixed', right: '20px', top: '50%', transform: 'translateY(-50%)',
                        borderRadius: '9999px', padding: '0', zIndex: 100,
                        display: 'flex', flexDirection: 'column', alignItems: 'center',
                    }}
                >
                    {/* Emote list */}
                    <div style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5.5px',
                        padding: '9px 5.5px 3.5px 5.5px',
                    }}>
                        {emotes.map(src => (
                            <button
                                key={src}
                                onClick={() => sendEmote(src)}
                                className={`emote-pill-btn${tappedEmote === src ? ' is-tapped' : ''}`}
                                style={{ transition: 'transform 0.1s' }}
                                onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.2)'}
                                onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                            >
                                <img src={src} alt="emote" style={{ width: '27px', height: '27px', objectFit: 'contain' }} />
                            </button>
                        ))}
                    </div>

                    {/* Collapse toggle — bottom of pill */}
                    <button
                        onClick={() => setCollapsed(true)}
                        title="Hide emotes"
                        style={{
                            background: 'none', border: 'none',
                            width: '40px', height: '27px',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0,
                            transition: 'color 0.2s',
                            borderTop: '1px solid rgba(255,255,255,0.08)',
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = '#fff'}
                        onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
                    >
                        <ChevronUp size={14} />
                    </button>
                </div>
            )}

            {/* Floating Reactions Layer */}
            <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 999, overflow: 'hidden' }}>
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

        </>
    )
}
