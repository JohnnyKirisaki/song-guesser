'use client'

import { useState } from 'react'
import { useUser } from '@/context/UserContext'
import { supabase } from '@/lib/supabase'
import { Upload, X } from 'lucide-react'

export default function ProfileEditor({ onClose }: { onClose: () => void }) {
    const { profile, signIn } = useUser()
    const [username, setUsername] = useState(profile?.username || '')
    const [avatarUrl, setAvatarUrl] = useState(profile?.avatar_url || '')
    const [file, setFile] = useState<File | null>(null)
    const [loading, setLoading] = useState(false)

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0])
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
                const fileExt = file.name.split('.').pop()
                const fileName = `${Math.random()}.${fileExt}`
                const { data, error } = await supabase.storage
                    .from('avatars')
                    .upload(fileName, file)

                if (error) throw error

                if (data) {
                    const { data: { publicUrl } } = supabase.storage
                        .from('avatars')
                        .getPublicUrl(fileName)
                    finalAvatarUrl = publicUrl
                }
            }

            await signIn(username, finalAvatarUrl)
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
                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                        <label className="avatar-uploader" style={{
                            width: '100px', height: '100px', borderRadius: '50%',
                            background: '#333', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', overflow: 'hidden', border: '2px solid var(--primary)', position: 'relative'
                        }}>
                            {avatarUrl ? (
                                <img src={avatarUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            ) : (
                                <Upload size={32} color="var(--secondary)" />
                            )}
                            <input type="file" accept="image/*" onChange={handleFileChange} style={{ display: 'none' }} />
                        </label>
                    </div>

                    <input
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="Username"
                        style={{
                            width: '100%', padding: '12px', borderRadius: 'var(--radius-md)',
                            background: '#222', border: '1px solid #333', color: 'white', outline: 'none'
                        }}
                    />

                    <input
                        type="url"
                        value={!file ? avatarUrl : ''}
                        onChange={(e) => { setAvatarUrl(e.target.value); setFile(null); }}
                        placeholder="Image URL"
                        style={{
                            width: '100%', padding: '12px', borderRadius: 'var(--radius-md)',
                            background: '#222', border: '1px solid #333', color: 'white', outline: 'none'
                        }}
                    />

                    <button type="submit" className="btn-primary" disabled={loading}>
                        {loading ? 'Saving...' : 'Save Changes'}
                    </button>
                </form>
            </div>
        </div>
    )
}
