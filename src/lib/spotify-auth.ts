
// ── Spotify token cache (client credentials, ~1h TTL) ──────────────
let cachedToken: { token: string; expiresAt: number } | null = null

export async function getSpotifyAccessToken(): Promise<string | null> {
    if (cachedToken && Date.now() < cachedToken.expiresAt) {
        return cachedToken.token
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
    if (!clientId || !clientSecret) return null

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        cache: 'no-store',
    }).catch(() => null)

    if (!res?.ok) return null
    const data = await res.json().catch(() => null) as { access_token?: string; expires_in?: number } | null
    if (!data?.access_token) return null

    cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + ((data.expires_in || 3600) - 60) * 1000,
    }
    return cachedToken.token
}
