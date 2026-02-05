'use client'

import { useState } from 'react'
import { useUser } from '@/context/UserContext'
import { X, Upload, Link as LinkIcon } from 'lucide-react'

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

export default function ProfileEditor({ onClose }: { onClose: () => void }) {
    const { profile, signIn } = useUser()
    const [username, setUsername] = useState(profile?.username || '')

    const [mode, setMode] = useState<'upload' | 'link'>('upload')
    const [avatarUrl, setAvatarUrl] = useState(profile?.avatar_url || '')
    const [file, setFile] = useState<File | null>(null)
    const [loading, setLoading] = useState(false)

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

                <h2 style={{ marginBottom: '24px', textAlign: 'center' }}>Edit Profile</h2>

                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

                    {/* Avatar Preview */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                        <div style={{
                            width: '100px', height: '100px', borderRadius: '50%',
                            background: '#333', overflow: 'hidden', border: '2px solid var(--primary)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative'
                        }}>
                            {avatarUrl ? (
                                <img src={avatarUrl} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>No Image</div>
                        )}
                        </div>
                    </div>

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
            </div>
        </div>
    )
}
