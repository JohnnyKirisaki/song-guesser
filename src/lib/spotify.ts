
import { db } from '@/lib/firebase'
import { ref, update, push, child } from 'firebase/database'
import { isMatch } from '@/lib/scoring'

import { shuffleArray } from './game-utils'

export type SpotifyTrack = {
    uri: string
    name: string
    artist: string
    spotify_artist_id?: string | null
    cover_url: string
    preview_url: string | null
}

export type FailedTrack = { artist: string, title: string }

export type ImportResult = { tracks: SpotifyTrack[], failed: FailedTrack[] }

type ResolveResult = { resolved: SpotifyTrack[], failed: FailedTrack[] }

// Helper: Resolve via new Server API (Deezer)
async function resolveViaServer(metadata: any[], clearLog: boolean = false): Promise<ResolveResult> {
    try {
        const res = await fetch('/api/resolve-tracks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tracks: metadata, clearLog })
        })
        const data = await res.json()

        if (!res.ok) throw new Error(data.error || 'Resolution failed')

        const resolved = data.tracks
            .filter((t: any) => t.resolved && t.deezer)
            .map((t: any) => ({
                uri: t.deezer.id,
                name: t.deezer.title,
                artist: t.deezer.artist,
                spotify_artist_id: t.input?.spotifyArtistId || null,
                cover_url: t.deezer.cover_url,
                preview_url: t.deezer.preview_url ? t.deezer.preview_url.replace(/^http:\/\//i, 'https://') : null
            }))

        const failed = data.tracks
            .filter((t: any) => !t.resolved || !t.deezer)
            .map((t: any) => ({ artist: t.input?.artist || '', title: t.input?.title || '' }))

        return { resolved, failed }
    } catch (e) {
        console.error('Server Resolution Error:', e)
        throw e
    }
}

type TrackMeta = { artist: string, title: string, album?: string, year?: string, isrc?: string, spotifyArtistId?: string | null }

async function resolveViaServerBatched(
    metadata: TrackMeta[],
    onProgress?: (value: number) => void
): Promise<ResolveResult> {
    const total = metadata.length
    if (total === 0) {
        onProgress?.(100)
        return { resolved: [], failed: [] }
    }

    const chunkSize = 25
    const allResolved: SpotifyTrack[] = []
    const allFailed: FailedTrack[] = []
    let processed = 0

    for (let i = 0; i < metadata.length; i += chunkSize) {
        const chunk = metadata.slice(i, i + chunkSize)
        const { resolved, failed } = await resolveViaServer(chunk, i === 0)
        allResolved.push(...resolved)
        allFailed.push(...failed)
        processed += chunk.length
        const pct = Math.min(100, Math.round((processed / total) * 100))
        onProgress?.(pct)
    }

    return { resolved: allResolved, failed: allFailed }
}

export async function fetchSpotifyData(
    input: string,
    onProgress?: (value: number) => void
): Promise<ImportResult> {
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

        const selectedMetadata = shuffleArray(allTracks)
        onProgress?.(20)
        const result = await resolveViaServerBatched(selectedMetadata.map((t: any) => ({
            artist: t.artist,
            title: t.name || t.title || ''
        })), (progress) => {
            onProgress?.(20 + Math.round(progress * 0.8))
        })
        onProgress?.(100)
        return { tracks: result.resolved, failed: result.failed }

    } else if (isSpotify) {
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

        const selectedMetadata = shuffleArray(allTracks)
        onProgress?.(20)
        const result = await resolveViaServerBatched(selectedMetadata.map((t: any) => ({
            artist: t.artist ?? '',
            title: t.name ?? '',
            album: t.album,
            year: t.year,
            isrc: t.isrc,
            spotifyArtistId: t.artistId ?? null
        })), (progress) => {
            onProgress?.(20 + Math.round(progress * 0.8))
        })
        onProgress?.(100)
        return { tracks: result.resolved, failed: result.failed }
    }

    const singleTrack = [{ artist: '', title: input }]
    try {
        onProgress?.(50)
        const result = await resolveViaServer(singleTrack)
        if (result.resolved.length > 0) {
            onProgress?.(100)
            return { tracks: result.resolved, failed: result.failed }
        }
    } catch (e) {
        // Fallback
    }

    const fallback = await resolveViaServer([{ artist: '', title: input }])
    onProgress?.(100)
    return { tracks: fallback.resolved, failed: fallback.failed }
}

export type ChartKey = 'worldwide' | 'portugal'

export async function fetchChartTracks(
    chartKey: ChartKey,
    onProgress?: (value: number) => void
): Promise<ImportResult> {
    onProgress?.(5)

    const res = await fetch(`/api/charts?chart=${chartKey}`)
    const data = await res.json()
    if (!res.ok || data.error) throw new Error(data.error || 'Failed to fetch chart')

    const tracks = data.tracks ?? []
    if (tracks.length === 0) throw new Error('Chart returned no tracks')

    // Deezer returned complete tracks (uri + preview_url) — no resolution needed
    if (data.resolved) {
        onProgress?.(100)
        return { tracks: tracks as SpotifyTrack[], failed: [] }
    }

    // Apple Music fallback: metadata only — resolve via Deezer search
    onProgress?.(15)
    const metadata = tracks.map((t: any) => ({ artist: t.artist, title: t.name }))
    const result = await resolveViaServerBatched(metadata, (progress) => {
        onProgress?.(15 + Math.round(progress * 0.85))
    })

    onProgress?.(100)
    return { tracks: result.resolved, failed: result.failed }
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
            spotify_artist_id: t.spotify_artist_id || null,
            artist_name: t.artist,
            track_name: t.name,
            cover_url: t.cover_url || null,
            preview_url: t.preview_url,
            picked_by_user_id: userId
        }
    })

    await update(ref(db), updates)
    return tracks.length
}
