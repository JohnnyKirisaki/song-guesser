
import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { isMatch } from '@/lib/scoring'

// Helper to duplicate the fetch logic from lib/spotify without importing client-side specific code if any
async function fetchPlaylistTracks(url: string) {
    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/playlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
    })
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    return data.tracks || []
}

async function resolveAudio(metadataList: any[]) {
    const resolved = []
    for (const meta of metadataList) {
        try {
            const cleanName = meta.name.replace(/\(.*\)/g, '').replace(/\[.*\]/g, '').replace(/feat\..*/i, '').trim()
            const query = `${meta.artist} ${cleanName}`

            const itunesRes = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=5`)
            const itunesData = await itunesRes.json()

            if (itunesData.results?.length > 0) {
                const match = itunesData.results.find((res: any) => {
                    // Simple lax match
                    return res.artistName.toLowerCase().includes(meta.artist.toLowerCase()) ||
                        meta.artist.toLowerCase().includes(res.artistName.toLowerCase())
                })

                if (match && match.previewUrl) {
                    resolved.push({
                        uri: `itunes:${match.trackId}`,
                        name: match.trackName,
                        artist: match.artistName,
                        cover_url: match.artworkUrl100?.replace('100x100', '600x600'),
                        preview_url: match.previewUrl
                    })
                }
            }
        } catch (e) {
            console.error('Resolution error for', meta.name, e)
        }
    }
    return resolved
}

export async function POST(request: Request) {
    try {
        const body = await request.json()
        const { roomCode, userIds } = body

        if (!roomCode || !userIds || !Array.isArray(userIds)) {
            return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 })
        }

        // 1. Get existing songs to avoid duplicates
        const { data: existingSongs } = await supabase
            .from('room_songs')
            .select('spotify_uri, artist_name, track_name')
            .eq('room_code', roomCode)

        const existingUris = new Set(existingSongs?.map(s => s.spotify_uri) || [])
        // Also track Artist-Title pairs for robust deduping
        const existingKeys = new Set(existingSongs?.map(s => `${s.artist_name.toLowerCase()}-${s.track_name.toLowerCase()}`) || [])

        // 2. For each user, fetch their playlist and find NEW songs
        let totalAdded = 0

        for (const userId of userIds) {
            // Get playlist URL
            const { data: player } = await supabase
                .from('room_players')
                .select('playlist_url')
                .eq('room_code', roomCode)
                .eq('user_id', userId)
                .single()

            if (!player?.playlist_url) {
                continue
            }

            const allTracks = await fetchPlaylistTracks(player.playlist_url)

            // Filter out existing
            const newCandidates = allTracks.filter((t: any) => { // 't' is metadata from Spotify/Scraper
                // We don't have URIs for metadata yet, so check if we can skip by name?
                // Actually the metadata from /api/playlist might have IDs if it was spotify.
                // But let's assume we rely on the resolved result.
                // Let's at least filter by name if possible, or just resolve a batch and check.
                // Better: Pick random candidates that *likely* aren't duplicates?
                // Since we can't check URI yet, we check Artist+Title match
                const key = `${t.artist.toLowerCase()}-${t.name.toLowerCase()}`
                return !existingKeys.has(key)
            })

            if (newCandidates.length === 0) continue

            // Pick 3 random candidates to try resolving
            const selection = newCandidates.sort(() => 0.5 - Math.random()).slice(0, 3)

            // Resolve
            const resolved = await resolveAudio(selection)

            // Double check resolved against existing URIs
            const trulyNew = resolved.filter(t => !existingUris.has(t.uri))

            if (trulyNew.length > 0) {
                // Insert
                const toInsert = trulyNew.map(t => ({
                    room_code: roomCode,
                    user_id: userId,
                    spotify_uri: t.uri,
                    artist_name: t.artist,
                    track_name: t.name,
                    cover_url: t.cover_url,
                    preview_url: t.preview_url,
                    picked_by_user_id: userId
                }))

                const { error } = await supabase.from('room_songs').insert(toInsert)
                if (!error) {
                    totalAdded += toInsert.length
                } else {
                    console.error('[FetchMore] Insert error:', error)
                }
            }
        }

        return NextResponse.json({ added: totalAdded })

    } catch (error: any) {
        console.error('[FetchMore] Error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
