import { supabase } from '@/lib/supabase'
import { isMatch } from '@/lib/scoring'

export type SpotifyTrack = {
    uri: string
    name: string
    artist: string
    cover_url: string
    preview_url: string | null
}

// ... rest of imports/types if any ...

export async function fetchSpotifyData(input: string): Promise<SpotifyTrack[]> {
    // Detect source type
    const isYouTube = input.includes('youtube.com') || input.includes('youtu.be')
    const isSpotify = input.includes('spotify.com') || input.includes('playlist')

    if (isYouTube) {
        // Call our YouTube scraper API
        const res = await fetch(`/api/youtube-playlist?url=${encodeURIComponent(input)}`)
        const data = await res.json()

        if (data.error) {
            console.error('[PlaylistLib] YouTube API Error:', data.error)
            throw new Error(data.error)
        }

        const allTracks = data.tracks
        if (allTracks.length === 0) throw new Error('Playlist is empty or could not be parsed')

        // Select random subset
        const SELECTION_COUNT = 20
        const selectedMetadata = allTracks.sort(() => 0.5 - Math.random()).slice(0, SELECTION_COUNT)

        // Resolve via iTunes (same as Spotify flow)
        return await resolveTracksViaItunes(selectedMetadata)

    } else if (isSpotify) {
        // 1. Fetch Track Metadata from our new API Route (Guest Token)
        const res = await fetch('/api/playlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: input })
        })
        const data = await res.json()

        if (data.error) {
            console.error('[PlaylistLib] API Error:', data.error)
            throw new Error(data.error)
        }

        const allTracks = data.tracks
        if (allTracks.length === 0) throw new Error('Playlist is empty')

        // 2. Randomly Select N tracks (e.g., 20)
        const SELECTION_COUNT = 20
        const selectedMetadata = allTracks.sort(() => 0.5 - Math.random()).slice(0, SELECTION_COUNT)

        // 3. Resolve via iTunes
        return await resolveTracksViaItunes(selectedMetadata)
    }

    // B. If input is a Search Term (Existing Logic)
    let query = input
    // 1. Determine search query
    // ... rest of logic

    // 2. Fetch from iTunes Search API (CORS friendly, JSON)
    try {
        const response = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=20`)
        const data = await response.json()

        if (!data.results || data.results.length === 0) {
            throw new Error('No tracks found')
        }

        // 3. Map to our format
        return data.results.map((track: any) => ({
            uri: `itunes:${track.trackId}`, // unique ID
            name: track.trackName,
            artist: track.artistName,
            cover_url: track.artworkUrl100?.replace('100x100', '600x600'), // Get higher res
            preview_url: track.previewUrl // .m4a 30s preview
        }))
            .filter((t: any) => t.preview_url) // Ensure we only get tracks with previews

    } catch (error) {
        console.error('iTunes API Error:', error)
        // Fallback to empty or throw
        throw error
    }
}

export async function addSongsToRoom(roomCode: string, userId: string, tracks: SpotifyTrack[]) {
    // 1. Fetch existing songs to check for duplicates (fuzzy match could happen here or in DB)
    // For now we assume strict check on artist + title (mocked db check)

    // 2. Prepare inserts
    const songs = tracks.map(t => ({
        room_code: roomCode,
        user_id: userId,
        spotify_uri: t.uri,
        artist_name: t.artist,
        track_name: t.name,
        cover_url: t.cover_url,
        preview_url: t.preview_url,
        picked_by_user_id: userId
    }))

    const { data: result, error } = await supabase.from('room_songs').insert(songs).select()

    if (error) {
        console.error('[SpotifyLib] Insert Error Details:', JSON.stringify(error, null, 2))
        throw error
    }

    return songs.length
}

// Helper function: Resolve tracks via iTunes API
async function resolveTracksViaItunes(selectedMetadata: any[]): Promise<SpotifyTrack[]> {
    const resolvedTracks: SpotifyTrack[] = []

    const promises = selectedMetadata.map(async (meta: any) => {
        try {
            // Clean up query (remove "feat.", "Remastered", "Remix", bracketed info)
            const cleanName = meta.name.replace(/\(.*\)/g, '').replace(/\[.*\]/g, '').replace(/feat\..*/i, '').replace(/-.*Remaster.*/i, '').replace(/-.*Remix.*/i, '').trim()
            const query = `${meta.artist} ${cleanName}`

            // Search with higher limit to find BEST artist match
            const itunesRes = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=5`)
            const itunesData = await itunesRes.json()

            if (itunesData.results && itunesData.results.length > 0) {
                // Find a match where BOTH artist and title are flexible matches
                const match = itunesData.results.find((res: any) => {
                    const artistMatch = isMatch(res.artistName, meta.artist, true)
                    const titleMatch = isMatch(res.trackName, meta.name, false)
                    return artistMatch && titleMatch
                })

                if (match && match.previewUrl) {
                    return {
                        uri: `itunes:${match.trackId}`,
                        name: match.trackName,
                        artist: match.artistName,
                        cover_url: match.artworkUrl100?.replace('100x100', '600x600'),
                        preview_url: match.previewUrl
                    }
                } else {
                    console.warn(`[PlaylistLib] No verified match for: ${meta.artist} - ${meta.name}. Skipping.`)
                }
            }
        } catch (e) {
            // console.warn('Failed to resolve track:', meta.name)
        }
        return null
    })

    const results = await Promise.all(promises)
    resolvedTracks.push(...(results.filter(t => t !== null) as SpotifyTrack[]))

    return resolvedTracks
}
