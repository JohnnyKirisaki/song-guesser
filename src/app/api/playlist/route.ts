import { NextResponse } from 'next/server'

export async function POST(request: Request) {
    try {
        const { url } = await request.json()

        // 1. Detect URL Type & Extract ID
        let urlType: 'playlist' | 'artist' | 'album' | null = null
        let resourceId: string | null = null

        // Playlist: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M or spotify:playlist:ID
        const playlistMatch = url.match(/playlist[\/:]([a-zA-Z0-9]+)/)
        if (playlistMatch) {
            urlType = 'playlist'
            resourceId = playlistMatch[1]
        }

        // Artist: https://open.spotify.com/artist/66CXWjxzNUsdJxJ2JdwvnR or spotify:artist:ID
        const artistMatch = url.match(/artist[\/:]([a-zA-Z0-9]+)/)
        if (artistMatch) {
            urlType = 'artist'
            resourceId = artistMatch[1]
        }

        // Album: https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy or spotify:album:ID
        const albumMatch = url.match(/album[\/:]([a-zA-Z0-9]+)/)
        if (albumMatch) {
            urlType = 'album'
            resourceId = albumMatch[1]
        }

        if (!urlType || !resourceId) {
            return NextResponse.json({
                error: 'Invalid Spotify URL. Supported: Playlist, Artist, or Album links.'
            }, { status: 400 })
        }

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
        const accessToken = tokenData.access_token

        // 3. Fetch Tracks based on URL type
        let allItems: any[] = []

        if (urlType === 'playlist') {
            // Fetch Playlist Tracks (Pagination)
            let nextUrl: string | null = `https://api.spotify.com/v1/playlists/${resourceId}/tracks?limit=50`

            while (nextUrl && allItems.length < 500) {
                const res = await fetch(nextUrl, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                })

                if (!res.ok) {
                    if (allItems.length === 0) {
                        const err = await res.text()
                        console.error('[API] Playlist Fetch Failed:', { status: res.status, statusText: res.statusText, body: err })
                        return NextResponse.json({
                            error: `Failed to fetch playlist (HTTP ${res.status}). ${res.status === 404 ? 'Playlist not found or private.' : res.status === 403 ? 'Access forbidden - playlist may be region-restricted.' : 'Check if the URL is correct.'}`
                        }, { status: 500 })
                    }
                    break
                }

                const pageData = await res.json()
                if (!pageData.items) break

                allItems.push(...pageData.items)
                nextUrl = pageData.next
            }
        }
        else if (urlType === 'artist') {
            // Fetch Artist's Top Tracks + Albums
            // First get top tracks (usually 10)
            const topTracksRes = await fetch(
                `https://api.spotify.com/v1/artists/${resourceId}/top-tracks?market=US`,
                { headers: { 'Authorization': `Bearer ${accessToken}` } }
            )

            if (topTracksRes.ok) {
                const topTracksData = await topTracksRes.json()
                allItems = topTracksData.tracks?.map((t: any) => ({ track: t })) || []
            }

            // Then get all albums
            let nextUrl: string | null = `https://api.spotify.com/v1/artists/${resourceId}/albums?limit=50&include_groups=album,single`
            const albums: any[] = []

            while (nextUrl && albums.length < 50) {
                const albumsRes = await fetch(nextUrl, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                })

                if (!albumsRes.ok) break

                const albumsData = await albumsRes.json()
                if (!albumsData.items) break

                albums.push(...albumsData.items)
                nextUrl = albumsData.next
            }

            // Fetch tracks from each album
            for (const album of albums.slice(0, 20)) { // Limit to 20 albums to prevent timeout
                const albumTracksRes = await fetch(
                    `https://api.spotify.com/v1/albums/${album.id}/tracks?limit=50`,
                    { headers: { 'Authorization': `Bearer ${accessToken}` } }
                )

                if (albumTracksRes.ok) {
                    const tracksData = await albumTracksRes.json()
                    const trackItems = tracksData.items?.map((t: any) => ({
                        track: { ...t, artists: t.artists || album.artists }
                    })) || []
                    allItems.push(...trackItems)
                }

                if (allItems.length >= 500) break
            }
        }
        else if (urlType === 'album') {
            // Fetch Album Tracks
            let nextUrl: string | null = `https://api.spotify.com/v1/albums/${resourceId}/tracks?limit=50`

            while (nextUrl && allItems.length < 500) {
                const res = await fetch(nextUrl, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                })

                if (!res.ok) {
                    if (allItems.length === 0) {
                        const err = await res.text()
                        console.error('[API] Album Fetch Failed:', err)
                        return NextResponse.json({
                            error: 'Failed to fetch album. It might not exist or the ID is wrong.'
                        }, { status: 500 })
                    }
                    break
                }

                const pageData = await res.json()
                if (!pageData.items) break

                // Album tracks don't have the full structure, need to get album info for artist
                const albumInfoRes = await fetch(
                    `https://api.spotify.com/v1/albums/${resourceId}`,
                    { headers: { 'Authorization': `Bearer ${accessToken}` } }
                )

                let albumArtists = []
                if (albumInfoRes.ok) {
                    const albumInfo = await albumInfoRes.json()
                    albumArtists = albumInfo.artists || []
                }

                const items = pageData.items.map((t: any) => ({
                    track: { ...t, artists: t.artists?.length > 0 ? t.artists : albumArtists }
                }))

                allItems.push(...items)
                nextUrl = pageData.next
            }
        }

        if (allItems.length === 0) {
            throw new Error(`No tracks found for this ${urlType}`)
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
