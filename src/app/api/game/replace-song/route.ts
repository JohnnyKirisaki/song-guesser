import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, get, update } from 'firebase/database'
import { SongItem } from '@/lib/game-logic'
import { fetchLyrics } from '@/lib/lyrics'
import { resolveSingleTrack } from '@/lib/deezer'

export async function POST(request: Request) {
    try {
        const { roomCode, roundIndex } = await request.json()

        const roomRef = ref(db, `rooms/${roomCode}`)
        const roomSnap = await get(roomRef)
        const roomData = roomSnap.val()

        if (!roomData) return NextResponse.json({ error: 'Room not found' }, { status: 404 })

        const allSongs = Object.values(roomData.songs || {}) as SongItem[]
        const usedSongIds = new Set<string>()

        // Collect used IDs from playlist
        const playlist = roomData.game_state?.playlist || []
        playlist.forEach((s: SongItem) => usedSongIds.add(s.id))

        // Find standard replacement
        const pool = allSongs.filter(s => !usedSongIds.has(s.id)).sort(() => 0.5 - Math.random())

        // If pool empty, try ANY song (duplicates allowed if desperate)
        // But for now, strict unique.
        if (pool.length === 0) {
            return NextResponse.json({ error: 'No replacement songs available' }, { status: 400 })
        }

        let replacement: SongItem | null = null
        let lyrics: string | null = null

        // Try to find one with audio (and lyrics if needed)
        const isLyricsOnly = roomData.settings?.mode === 'lyrics_only'

        for (const candidate of pool) {
            // Check Audio FIRST (since that's why we are replacing)
            // If masked (no preview_url), try to resolve it now on server side?
            // Or just trust it works? 
            // Better to verify it resolves.
            let preview = candidate.preview_url
            if (!preview) {
                const resolved = await resolveSingleTrack({
                    artist: candidate.artist_name,
                    title: candidate.track_name
                })
                preview = resolved.deezer?.preview_url || null
            }

            if (!preview) continue // helper needs audio!

            if (isLyricsOnly) {
                const l = await fetchLyrics(candidate.artist_name, candidate.track_name)
                if (!l) continue
                lyrics = l
            }

            replacement = { ...candidate, preview_url: preview }
            break
        }

        if (!replacement) {
            return NextResponse.json({ error: 'Could not find a valid replacement with audio' }, { status: 500 })
        }

        const updates: Record<string, any> = {}

        // Replace in Playlist
        updates[`rooms/${roomCode}/game_state/playlist/${roundIndex}`] = {
            ...replacement,
            artist_name: '???',
            track_name: '???',
            cover_url: '',
            spotify_uri: replacement.spotify_uri || '' // Unmasked
        }

        // Update Secret
        updates[`room_secrets/${roomCode}/${roundIndex}`] = replacement

        if (lyrics) {
            updates[`rooms/${roomCode}/lyrics_cache/${replacement.id}`] = lyrics
        }

        await update(ref(db), updates)

        return NextResponse.json({ success: true, song: replacement })
    } catch (e: any) {
        console.error('Replace Song Error:', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}
