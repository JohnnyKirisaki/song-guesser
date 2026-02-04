import { NextResponse } from 'next/server'

export async function POST(request: Request) {
    try {
        const { url } = await request.json()

        // 1. Extract Playlist ID
        // Supports: 
        // https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
        // spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
        const match = url.match(/playlist[\/:]([a-zA-Z0-9]+)/)
        if (!match) {
            return NextResponse.json({ error: 'Invalid Spotify Playlist URL' }, { status: 400 })
        }
        const playlistId = match[1]

        const clientId = process.env.SPOTIFY_CLIENT_ID
        const clientSecret = process.env.SPOTIFY_CLIENT_SECRET

        if (!clientId || !clientSecret) {
            console.error('[API] Missing Spotify Credentials')
            return NextResponse.json({
                error: 'Server is missing Spotify Keys. Please add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env.local and RESTART the server.'
            }, { status: 500 })
        }

        // 2. Get Access Token (Client Credentials Flow)
        const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
        const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        })

        if (!tokenRes.ok) {
            const err = await tokenRes.text()
            console.error('[API] Token Fetch Failed:', err)
            return NextResponse.json({ error: 'Failed to authenticate with Spotify. Check your Client ID and Secret.' }, { status: 500 })
        }

        const tokenData = await tokenRes.json()

        // 3. Fetch Playlist Tracks (Pagination)
        let allItems: any[] = []
        let nextUrl: string | null = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50`

        while (nextUrl && allItems.length < 500) { // Hard limit 500 to prevent timeouts
            const playlistRes: any = await fetch(nextUrl, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            })

            if (!playlistRes.ok) {
                // If first request fails, throw. If subsequent, just stop.
                if (allItems.length === 0) {
                    const err = await playlistRes.text()
                    console.error('[API] Playlist Fetch Failed:', err)
                    return NextResponse.json({ error: 'Failed to fetch playlist. It might be private or the ID is wrong.' }, { status: 500 })
                }
                break
            }

            const pageData = await playlistRes.json()
            if (!pageData.items) break

            allItems.push(...pageData.items)
            nextUrl = pageData.next
        }

        if (allItems.length === 0) {
            throw new Error('Failed to fetch playlist tracks')
        }

        // 4. Simplify Data
        const tracks = allItems.map((item: any) => {
            if (!item.track) return null
            return {
                name: item.track.name,
                artist: item.track.artists[0]?.name
            }
        }).filter((t: any) => t && t.name && t.artist)

        return NextResponse.json({ tracks })

    } catch (error: any) {
        console.error('[API] Critical Error:', error)
        return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 })
    }
}
