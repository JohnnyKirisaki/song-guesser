'use client'

import { useState, useEffect, useRef } from 'react'
import { db } from '@/lib/firebase'
import { ref, push, onChildAdded, query, limitToLast } from 'firebase/database'
import { Send } from 'lucide-react'

type ChatMessage = {
    id: string
    userId: string
    username: string
    avatar_url: string
    text: string
    timestamp: number
}

export default function LobbyChat({ roomCode, userId, username, avatarUrl }: {
    roomCode: string
    userId: string
    username: string
    avatarUrl: string
}) {
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [input, setInput] = useState('')
    const bottomRef = useRef<HTMLDivElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!roomCode) return

        const chatRef = query(ref(db, `rooms/${roomCode}/chat`), limitToLast(50))
        const unsubscribe = onChildAdded(chatRef, (snapshot) => {
            const data = snapshot.val()
            if (!data) return
            setMessages(prev => {
                const msg: ChatMessage = { id: snapshot.key!, ...data }
                if (prev.some(m => m.id === msg.id)) return prev
                return [...prev, msg].slice(-50)
            })
        })

        return () => unsubscribe()
    }, [roomCode])

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages])

    const sendMessage = async () => {
        const text = input.trim()
        if (!text) return
        setInput('')

        try {
            await push(ref(db, `rooms/${roomCode}/chat`), {
                userId,
                username,
                avatar_url: avatarUrl,
                text,
                timestamp: Date.now()
            })
        } catch (err) {
            console.error('[Chat] Failed to send:', err)
        }
    }

    return (
        <div style={{
            display: 'flex', flexDirection: 'column',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            paddingTop: '16px', marginTop: '16px',
            flex: 1, minHeight: 0,
        }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Chat
            </div>

            {/* Messages */}
            <div
                ref={containerRef}
                style={{
                    flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px',
                    minHeight: '80px', maxHeight: '200px',
                    paddingRight: '4px',
                }}
            >
                {messages.map(msg => (
                    <div key={msg.id} className="chat-msg-enter" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <img
                            src={msg.avatar_url || 'https://via.placeholder.com/24'}
                            alt=""
                            style={{ width: '20px', height: '20px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                        />
                        <div style={{ fontSize: '0.82rem', lineHeight: 1.35 }}>
                            <span style={{
                                fontWeight: 700,
                                color: msg.userId === userId ? 'var(--primary)' : 'var(--text-main)',
                                marginRight: '6px',
                            }}>
                                {msg.username}
                            </span>
                            <span style={{ color: 'var(--text-muted)' }}>{msg.text}</span>
                        </div>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                <input
                    type="text"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && sendMessage()}
                    placeholder="Type a message..."
                    className="ui-input"
                    style={{ flex: 1, padding: '8px 12px', fontSize: '0.82rem' }}
                    maxLength={200}
                />
                <button
                    onClick={sendMessage}
                    disabled={!input.trim()}
                    style={{
                        background: 'none', border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px', padding: '8px 10px',
                        color: input.trim() ? 'var(--primary)' : 'var(--text-muted)',
                        cursor: input.trim() ? 'pointer' : 'default',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'color 0.2s, border-color 0.2s',
                    }}
                >
                    <Send size={16} />
                </button>
            </div>
        </div>
    )
}
