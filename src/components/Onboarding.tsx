'use client'

import { useState, useEffect } from 'react'
import { useUser } from '@/context/UserContext'
import { Upload, Search } from 'lucide-react'
import { db } from '@/lib/firebase'
import { ref, get } from 'firebase/database'

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
                const MAX_SIZE = 150;
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
                resolve(canvas.toDataURL('image/jpeg', 0.7));
            }
            img.onerror = reject;
        }
        reader.onerror = reject;
    })
}

export default function Onboarding() {
    const { signIn } = useUser()
    const [username, setUsername] = useState('')

    const [mode, setMode] = useState<'upload' | 'link'>('upload')
    const [avatarUrl, setAvatarUrl] = useState('')
    const [file, setFile] = useState<File | null>(null)
    const [loading, setLoading] = useState(false)
    const [checkingDb, setCheckingDb] = useState(false)

    // Load saved profile (Local Device Persistence - Priority 1)
    useEffect(() => {
        const saved = localStorage.getItem('beatbattle_profile')
        if (saved) {
            try {
                const p = JSON.parse(saved)
                setUsername(p.username || '')
                setAvatarUrl(p.avatar_url || '')
            } catch (e) {
                console.error('Failed to load saved profile', e)
            }
        }
    }, [])

    const checkGlobalProfile = async () => {
        if (!username || file) return // Don't overwrite if user selected a file

        try {
            setCheckingDb(true)
            const slug = username.trim().toLowerCase()
            const snapshot = await get(ref(db, `usernames/${slug}`))

            if (snapshot.exists()) {
                const data = snapshot.val()
                if (data.avatar_url) {
                    setAvatarUrl(data.avatar_url)
                    // If it's a link, switch specific mode so they see it
                    if (data.avatar_url.startsWith('http')) {
                        setMode('link')
                    }
                }
            }
        } catch (e) {
            console.error(e)
        } finally {
            setCheckingDb(false)
        }
    }

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const f = e.target.files[0]
            setFile(f)
            setAvatarUrl(URL.createObjectURL(f)) // Preview URL (blob)
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

            // STRICT VALIDATION: Must have Final URL
            if (!finalUrl) {
                alert("Please upload an image or provide a link to play!")
                setLoading(false)
                return
            }

            // Save for next time
            localStorage.setItem('beatbattle_profile', JSON.stringify({
                username,
                avatar_url: finalUrl
            }))

            await signIn(username, finalUrl)
        } catch (error: any) {
            console.error('Onboarding error:', error)
            alert(`Failed to create profile: ${error.message || JSON.stringify(error)}`)
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="glass-panel" style={{ padding: '40px', maxWidth: '400px', width: '100%', margin: '0 20px' }}>
            <h2 style={{ marginBottom: '24px', textAlign: 'center' }}>Welcome Player</h2>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

                {/* Avatar Preview */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                    <div style={{
                        width: '100px', height: '100px', borderRadius: '50%',
                        background: '#333', overflow: 'hidden', border: '2px solid var(--primary)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative'
                    }}>
                        {avatarUrl ? (
                            <img
                                src={avatarUrl}
                                alt="Avatar"
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                        ) : (
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: '10px' }}>
                                No Image Selected
                            </div>
                        )}
                    </div>
                </div>

                <div>
                    <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem' }}>Username</label>
                    <div style={{ position: 'relative' }}>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            onBlur={checkGlobalProfile} // Look up on DB when leaving field
                            placeholder="Enter your name"
                            className="ui-input"
                            required
                        />
                        {checkingDb && (
                            <div style={{ position: 'absolute', right: '12px', top: '12px' }}>
                                <Search size={16} className="animate-spin" color="#888" />
                            </div>
                        )}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '4px' }}>
                        Type name to load existing profile
                    </div>
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


                <button
                    type="submit"
                    className="btn-primary"
                    disabled={loading || checkingDb}
                    style={{ marginTop: '12px', opacity: (loading || checkingDb) ? 0.7 : 1 }}
                >
                    {checkingDb ? 'Checking...' : (loading ? 'Joining...' : 'Start Playing')}
                </button>
            </form>
        </div>
    )
}
