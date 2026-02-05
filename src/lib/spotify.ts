import { db } from '@/lib/firebase'
import { ref, update, push, child } from 'firebase/database'
import { isMatch } from '@/lib/scoring'

import { shuffleArray } from './game-utils'

export type SpotifyTrack = {
    uri: string
    name: string
    artist: string
    cover_url: string
    preview_url: string | null
}

// Helper: Resolve via new Server API (Deezer)
async function resolveViaServer(metadata: any[]): Promise<SpotifyTrack[]> {
    try {
        const res = await fetch('/api/resolve-tracks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tracks: metadata })
        })
        const data = await res.json()

        if (!res.ok) throw new Error(data.error || 'Resolution failed')

            return data.tracks
            .filter((t: any) => t.resolved && t.deezer)
            .map((t: any) => ({
                uri: t.deezer.id,
                name: t.deezer.title,
                artist: t.deezer.artist,
                cover_url: t.deezer.cover_url,
                preview_url: t.deezer.preview_url ? t.deezer.preview_url.replace(/^http:\/\//i, 'https://') : null
            }))
    } catch (e) {
        console.error('Server Resolution Error:', e)
        throw e
    }
}

type TrackMeta = { artist: string, title: string }

async function resolveViaServerBatched(
    metadata: TrackMeta[],
    onProgress?: (value: number) => void
): Promise<SpotifyTrack[]> {
    const total = metadata.length
    if (total === 0) {
        onProgress?.(100)
        return []
    }

    const chunkSize = 25
    const results: SpotifyTrack[] = []
    let processed = 0

    for (let i = 0; i < metadata.length; i += chunkSize) {
        const chunk = metadata.slice(i, i + chunkSize)
        const resolved = await resolveViaServer(chunk)
        results.push(...resolved)
        processed += chunk.length
        const pct = Math.min(100, Math.round((processed / total) * 100))
        onProgress?.(pct)
    }

    return results
}

export async function fetchSpotifyData(
    input: string,
    onProgress?: (value: number) => void
): Promise<SpotifyTrack[]> {
    // Detect source type
    const isYouTube = input.includes('youtube.com') || input.includes('youtu.be')
    const isSpotify = input.includes('spotify.com') || input.includes('playlist')

    if (isYouTube) {
        // Call our YouTube scraper API
        onProgress?.(5)
        const res = await fetch(`/api/youtube-playlist?url=${encodeURIComponent(input)}`)
        const data = await res.json()

        if (data.error) throw new Error(data.error)

        const allTracks = data.tracks || []
        if (allTracks.length === 0) throw new Error('Playlist is empty or could not be parsed')

        // Shuffle but DO NOT limit: fetch all tracks (even if >50)
        const selectedMetadata = shuffleArray(allTracks)
        onProgress?.(20)
        const resolved = await resolveViaServerBatched(selectedMetadata.map((t: any) => ({
            artist: t.artist,
            title: t.name || t.title || ''
        })), (progress) => {
            onProgress?.(20 + Math.round(progress * 0.8))
        })
        onProgress?.(100)
        return resolved

    } else if (isSpotify) {
        // 1. Fetch Track Metadata
        onProgress?.(5)
        const res = await fetch('/api/playlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: input })
        })
        const data = await res.json()

        if (data.error) throw new Error(data.error)

        const allTracks = data.tracks
        if (allTracks.length === 0) throw new Error('Playlist is empty')

        // 2. Resolve via Server (Deezer) - Shuffle but DO NOT limit
        const selectedMetadata = shuffleArray(allTracks)
        onProgress?.(20)
        const resolved = await resolveViaServerBatched(selectedMetadata.map((t: any) => ({
            artist: t.artist,
            title: t.name || t.title || ''
        })), (progress) => {
            onProgress?.(20 + Math.round(progress * 0.8))
        })
        onProgress?.(100)
        return resolved
    }

    // B. If input is a Search Term
    // For now, we wrap the search term into a "track" and try to resolve it, 
    // OR we can leave the legacy iTunes search if it works for single terms.
    // Given the CORS issues, let's try to leverage the server resolver 
    // by treating the input as a "Title".

    // Attempting to use Server Resolver for single search too
    const singleTrack = [{ artist: '', title: input }]
    try {
        onProgress?.(50)
        const results = await resolveViaServer(singleTrack)
        if (results.length > 0) {
            onProgress?.(100)
            return results
        }
    } catch (e) {
        // Fallback or silence
    }

    // If strict resolver fails (because it expects artist+title), we might throw
    // But the user mainly complained about Playlist Import. 
    // Let's implement a simple iTunes Server Proxy if strictly needed, 
    // but typically "Search" implies typing "Drake". 
    // Our resolver `queries` array does have `track.title` fallback.
    // So `artist: '', title: 'Drake'` -> query `Drake` -> should work on Deezer!

    const fallback = await resolveViaServer([{ artist: '', title: input }])
    onProgress?.(100)
    return fallback
}

export async function addSongsToRoom(roomCode: string, userId: string, tracks: SpotifyTrack[]) {
    // Push multiple songs at once
    const updates: Record<string, any> = {}

    tracks.forEach(t => {
        const songId = `song_${Math.random().toString(36).substr(2, 9)}`
        updates[`rooms/${roomCode}/songs/${songId}`] = {
            id: songId,
            room_code: roomCode,
            user_id: userId,
            spotify_uri: t.uri,
            artist_name: t.artist,
            track_name: t.name,
            cover_url: t.cover_url,
            preview_url: t.preview_url,
            picked_by_user_id: userId
        }
    })

    await update(ref(db), updates)
    return tracks.length
}
