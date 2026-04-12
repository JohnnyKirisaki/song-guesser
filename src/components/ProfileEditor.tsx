'use client'

import { useState } from 'react'
import { useUser } from '@/context/UserContext'
import { X, Upload, Link as LinkIcon, Plus, Trash2 } from 'lucide-react'
import { db } from '@/lib/firebase'
import { ref, update } from 'firebase/database'

// Helper: Compress Image to Base64 (Max 150px)
const compressImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target?.result as string;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 150; // Small enough for RTDB
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > MAX_SIZE) {
                        height *= MAX_SIZE / width;
                        width = MAX_SIZE;
                    }
                } else {
                    if (height > MAX_SIZE) {
                        width *= MAX_SIZE / height;
                        height = MAX_SIZE;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx?.drawImage(img, 0, 0, width, height);
                // JDBC Quality 0.7
                resolve(canvas.toDataURL('image/jpeg', 0.7));
            }
            img.onerror = reject;
        }
        reader.onerror = reject;
    })
}

const normalizePlaylistUrl = (raw: string): string => {
    const value = raw.trim()
    if (!value) return ''

    try {
        const parsed = new URL(value)
        const host = parsed.hostname.toLowerCase()

        // Normalize Spotify playlist links (ignore tracking query params)
        if (host.includes('spotify.com') && parsed.pathname.includes('/playlist/')) {
            const match = parsed.pathname.match(/\/playlist\/([a-zA-Z0-9]+)/)
            if (match?.[1]) return `https://open.spotify.com/playlist/${match[1]}`
        }

        // Normalize YouTube playlist links to list id
        if (host.includes('youtube.com') || host.includes('youtu.be')) {
            const list = parsed.searchParams.get('list')
            if (list) return `https://www.youtube.com/playlist?list=${list}`
        }

        return parsed.toString().toLowerCase()
    } catch {
        return value.toLowerCase()
    }
}

export default function ProfileEditor({ onClose }: { onClose: () => void }) {
    const { profile, signIn, updateProfile } = useUser()
    const [username, setUsername] = useState(profile?.username || '')

    const [mode, setMode] = useState<'upload' | 'link'>('upload')
    const [avatarUrl, setAvatarUrl] = useState(profile?.avatar_url || '')
    const [file, setFile] = useState<File | null>(null)
    const [loading, setLoading] = useState(false)
    
    const [activeTab, setActiveTab] = useState<'account' | 'playlists'>('account')
    const [newPlaylistUrl, setNewPlaylistUrl] = useState('')
    const [newPlaylistName, setNewPlaylistName] = useState('')
    
    // Derive directly from profile to prevent stale state race conditions
    const playlists = profile?.saved_playlists || []

    // Removed Randomize logic

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const f = e.target.files[0]
            setFile(f)
            setAvatarUrl(URL.createObjectURL(f)) // Preview
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!username) return
        setLoading(true)

        let finalUrl = avatarUrl

        try {
            // 1. Handle File -> Base64
            if (mode === 'upload' && file) {
                finalUrl = await compressImage(file)
            }

            // STRICT VALIDATION
            if (!finalUrl && !file) {
                alert("Please choose a profile picture.")
                setLoading(false)
                return
            }

            // Save to LocalStorage
            localStorage.setItem('beatbattle_profile', JSON.stringify({
                username,
                avatar_url: finalUrl
            }))

            await signIn(username, finalUrl)
            onClose()
        } catch (error: any) {
            console.error('Update error:', error)
            alert(`Failed to update profile: ${error.message}`)
        } finally {
            setLoading(false)
        }
    }

    const handleAddPlaylist = async () => {
        if (!newPlaylistUrl || !newPlaylistName) return
        const normalizedNewUrl = normalizePlaylistUrl(newPlaylistUrl)
        const duplicate = playlists.some(pl => normalizePlaylistUrl(pl.url) === normalizedNewUrl)
        if (duplicate) return

        const updated = [...playlists, { name: newPlaylistName, url: newPlaylistUrl.trim() }]
        setNewPlaylistName('')
        setNewPlaylistUrl('')
        if (profile?.id) {
            await update(ref(db, `profiles/${profile.id}`), { saved_playlists: updated })
            await updateProfile({ saved_playlists: updated })
        }
    }

    const handleRemovePlaylist = async (index: number) => {
        const updated = playlists.filter((_, i) => i !== index)
        if (profile?.id) {
            await update(ref(db, `profiles/${profile.id}`), { saved_playlists: updated })
            await updateProfile({ saved_playlists: updated })
        }
    }

    return (
        <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
            backdropFilter: 'blur(8px)', zIndex: 200,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
            <div className="glass-panel" style={{ padding: '32px', maxWidth: '400px', width: '100%', position: 'relative' }}>
                <button
                    onClick={onClose}
                    style={{ position: 'absolute', top: '16px', right: '16px', color: 'var(--text-muted)' }}
                >
                    <X size={24} />
                </button>

                <h2 style={{ marginBottom: '16px', textAlign: 'center' }}>Edit Profile</h2>

                {/* Header (Avatar & Username) */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                    <div style={{
                        width: '90px', height: '90px', borderRadius: '50%',
                        background: '#333', overflow: 'hidden', border: '2px solid var(--primary)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative'
                    }}>
                        {avatarUrl ? (
                            <img src={avatarUrl} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>No Image</div>
                        )}
                    </div>
                    <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800 }}>{profile?.username || 'Player'}</h3>
                </div>

                {/* Tabs */}
                <div className="segmented" style={{ marginBottom: '20px' }}>
                    <button type="button" onClick={() => setActiveTab('account')} className={activeTab === 'account' ? 'active' : ''}>
                        Account Info
                    </button>
                    <button type="button" onClick={() => setActiveTab('playlists')} className={activeTab === 'playlists' ? 'active' : ''}>
                        Playlists
                    </button>
                </div>

                {activeTab === 'account' ? (
                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <label style={{ fontSize: '0.9rem' }}>Username</label>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder="Username"
                            className="ui-input"
                        />
                    </div>

                    {/* Mode Toggles */}
                    <div className="segmented">
                        <button
                            type="button"
                            onClick={() => setMode('upload')}
                            className={mode === 'upload' ? 'active' : ''}
                        >
                            Upload File
                        </button>
                        <button
                            type="button"
                            onClick={() => setMode('link')}
                            className={mode === 'link' ? 'active' : ''}
                        >
                            Or Paste URL
                        </button>
                    </div>

                    {/* Dynamic Inputs */}
                    {mode === 'upload' ? (
                        <div style={{ textAlign: 'center' }}>
                            <label className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.9rem', padding: '10px 20px' }}>
                                <Upload size={18} />
                                {file ? 'Change File' : 'Choose Image'}
                                <input type="file" accept="image/*" onChange={handleFileChange} style={{ display: 'none' }} />
                            </label>
                            {file && <div style={{ marginTop: '8px', fontSize: '0.8rem', color: '#ccc' }}>Selected: {file.name}</div>}
                            <div style={{ marginTop: '8px', fontSize: '0.75rem', color: '#666' }}>
                                Image is compressed & stored securely.
                            </div>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <input
                            type="url"
                            value={!file ? avatarUrl : ''}
                            onChange={(e) => { setAvatarUrl(e.target.value); setFile(null); }}
                            placeholder="https://example.com/image.png"
                            className="ui-input"
                        />
                    </div>
                    )}

                    <button type="submit" className="btn-primary" disabled={loading}>
                        {loading ? 'Saving...' : 'Save Changes'}
                    </button>
                </form>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {/* Playlist List */}
                        <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {playlists.map((pl, i) => (
                                <div key={i} className="glass-panel" style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div style={{ minWidth: 0, paddingRight: '12px' }}>
                                        <div style={{ fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pl.name}</div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pl.url}</div>
                                    </div>
                                    <button onClick={() => handleRemovePlaylist(i)} style={{ color: 'var(--error)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                            ))}
                            {playlists.length === 0 && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', padding: '12px' }}>No saved playlists yet.</div>}
                        </div>

                        {/* Add New Playlist */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px', background: 'rgba(255,255,255,0.03)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                            <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>Add New Playlist</div>
                            <input type="text" placeholder="Playlist Name (e.g. Pop Hits)" value={newPlaylistName} onChange={e => setNewPlaylistName(e.target.value)} className="ui-input" style={{ fontSize: '0.85rem', padding: '10px' }} />
                            <input type="url" placeholder="Spotify/YouTube URL" value={newPlaylistUrl} onChange={e => setNewPlaylistUrl(e.target.value)} className="ui-input" style={{ fontSize: '0.85rem', padding: '10px' }} />
                            <button onClick={handleAddPlaylist} className="btn-primary" disabled={!newPlaylistName || !newPlaylistUrl} style={{ padding: '10px', fontSize: '0.85rem', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                                <Plus size={16} /> Add to Profile
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
