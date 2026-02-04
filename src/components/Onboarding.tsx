'use client'

import { useState } from 'react'
import { useUser } from '@/context/UserContext'
import { supabase } from '@/lib/supabase'
import { Upload } from 'lucide-react'

export default function Onboarding() {
    const { signIn } = useUser()
    const [username, setUsername] = useState('')
    const [avatarUrl, setAvatarUrl] = useState('')
    const [file, setFile] = useState<File | null>(null)
    const [loading, setLoading] = useState(false)

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0])
            // Create local preview
            setAvatarUrl(URL.createObjectURL(e.target.files[0]))
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!username) return
        setLoading(true)

        let finalAvatarUrl = avatarUrl

        try {
            if (file) {
                // Upload to Supabase Storage
                const fileExt = file.name.split('.').pop()
                const fileName = `${Math.random()}.${fileExt}`
                const { data, error } = await supabase.storage
                    .from('avatars')
                    .upload(fileName, file)

                if (error) {
                    console.error('Upload error:', error)
                    // Fallback if storage fails or not set up
                }

                if (data) {
                    const { data: { publicUrl } } = supabase.storage
                        .from('avatars')
                        .getPublicUrl(fileName)
                    finalAvatarUrl = publicUrl
                }
            }
            // Removed Dicebear fallback here to let backend handle it for NEW profiles only

            await signIn(username, finalAvatarUrl)
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

                {/* Avatar Upload */}
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <label
                        style={{
                            width: '100px',
                            height: '100px',
                            borderRadius: '50%',
                            background: '#333',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            overflow: 'hidden',
                            border: '2px solid var(--primary)',
                            position: 'relative'
                        }}
                    >
                        {avatarUrl ? (
                            <img src={avatarUrl} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                            <Upload size={32} color="var(--secondary)" />
                        )}
                        <input type="file" accept="image/*" onChange={handleFileChange} style={{ display: 'none' }} />
                    </label>
                </div>
                <div style={{ textAlign: 'center', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                    Click to upload or paste URL below
                </div>

                <div>
                    <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem' }}>Username</label>
                    <input
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="Enter your name"
                        style={{
                            width: '100%',
                            padding: '12px',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid #333',
                            background: '#222',
                            color: 'white',
                            outline: 'none'
                        }}
                        required
                    />
                </div>

                <div>
                    <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem' }}>Or Image URL</label>
                    <input
                        type="url"
                        value={!file ? avatarUrl : ''}
                        onChange={(e) => { setAvatarUrl(e.target.value); setFile(null); }}
                        placeholder="https://..."
                        style={{
                            width: '100%',
                            padding: '12px',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid #333',
                            background: '#222',
                            color: 'white',
                            outline: 'none'
                        }}
                    />
                </div>

                <button
                    type="submit"
                    className="btn-primary"
                    disabled={loading}
                    style={{ marginTop: '12px', opacity: loading ? 0.7 : 1 }}
                >
                    {loading ? 'Joining...' : 'Start Playing'}
                </button>
            </form>
        </div>
    )
}
