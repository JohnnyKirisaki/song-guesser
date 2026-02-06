import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, update } from 'firebase/database'
import { prepareGamePayload, SongItem } from '@/lib/game-logic'

export async function POST(request: Request) {
    try {
        const { roomCode, settings } = await request.json()

        if (!roomCode || !settings) {
            return NextResponse.json({ error: 'Missing params' }, { status: 400 })
        }

        // 1. Generate Playlist (Server Side)
        const { updates, playlist } = await prepareGamePayload(
            roomCode,
            settings,
            async (percent) => {
                // Background update progress
                await update(ref(db, `rooms/${roomCode}`), {
                    creation_progress: percent
                })
            }
        )

        // 2. Separate Secrets & Mask Public Data
        const secrets: Record<string, SongItem> = {}
        const maskedPlaylist: any[] = []

        playlist.forEach((song, index) => {
            // Store full details in secrets
            secrets[index] = song

            // Create masked version for public state
            // We ONLY keep: id, spotify_uri (if needed? no), preview_url, picked_by_user_id
            // We REMOVE: artist_name, track_name, cover_url
            // Spotify URI might be sensitive if they copy-paste it? 
            // Better to mask it too. BUT client needs it to refresh token?
            // Client logic 'GamePage' uses 'trackId' (spotify_uri) for 'refresh-track'.
            // If we mask it, Client cannot refresh.
            // But `refresh-track` endpoint takes ID. 
            // Is ID the Spotify ID? "spotify:track:..."
            // If user sees Spotify ID, they can cheat.
            // So we MUST mask Spotify ID too.
            // How to handle Refresh?
            // The Server knows the mapping from "Game Song ID" to "Spotify ID".
            // But `currentSong` has `id`.
            // We can store `spotify_uri` in secrets.
            // And `refresh-track` could accept `songIndex` vs `roomId`?
            // Or `refresh-track` accepts `previewUrl`?
            // Currently `GamePage` passes `trackId = currentSong.spotify_uri`.
            // If I mask it, `refresh-track` breaks.
            // Solution: 
            // 1. Don't mask spotify_uri? (Risk: Cheat via spotify search)
            // 2. Update `refresh-track` to take `roomCode` + `roundIndex`?
            //    Or just `songId` (Firebase key)? No, songs use UUIDs.
            //    If I use `song.id` (UUID), I can lookup the song in DB secrets.
            //    YES.
            //    I should assume `spotify_uri` is masked.

            maskedPlaylist.push({
                id: song.id,
                picked_by_user_id: song.picked_by_user_id,
                preview_url: song.preview_url,
                // Mask the rest
                artist_name: '???',
                track_name: '???',
                cover_url: '',
                spotify_uri: '' // Masked
            })
        })

        // Modify the payload to use masked playlist (In-Place to avoid path collision)
        if (updates[`rooms/${roomCode}/game_state`]) {
            updates[`rooms/${roomCode}/game_state`].playlist = maskedPlaylist
        }

        // Write Secrets to `room_secrets/${roomCode}`
        updates[`room_secrets/${roomCode}`] = secrets

        // 3. Lyrics Handling (Server Side Prefetch)
        if (settings.mode === 'lyrics_only') {
            const BATCH_SIZE = 5
            const lyricsUpdates: Record<string, string> = {}

            // We process in background or wait?
            // Waiting might timeout the request if many songs.
            // But we can limit the batch or just fire-and-forget?
            // Next.js API routes shouldn't fire-and-forget easily without blocking.
            // Let's do a best-effort for first few songs, or just rely on the existing Loop logic BUT executed here.

            // Actually, we can write the secrets and game start updates first.
            // Then fetch lyrics?
            // Updates to Firebase are atomic.
            // Fetching lyrics is slow.
            // If we wait for all lyrics, game start is delayed.
            // Strategy: Start game immediately. Fetch lyrics in background?
            // Vercel serverless functions kill background tasks when response is sent.
            // So we must wait or use Edge functions?
            // Or just fetch first 2-3 songs now, and fetch others on demand (in Reveal API or lazy load).
            // `api/reveal` has lazy load fallback.
            // Let's fetch first 3 songs here to ensure smooth start.
            const initialBatch = playlist.slice(0, 3)
            await Promise.all(initialBatch.map(async (song) => {
                try {
                    const apiUrl = new URL(request.url).origin + `/api/lyrics?artist=${encodeURIComponent(song.artist_name)}&title=${encodeURIComponent(song.track_name)}`
                    const res = await fetch(apiUrl)
                    const data = await res.json()
                    if (data.lyrics) {
                        lyricsUpdates[`rooms/${roomCode}/lyrics_cache/${song.id}`] = data.lyrics
                    }
                } catch (e) {
                    // ignore
                }
            }))

            // Apply lyrics updates
            Object.entries(lyricsUpdates).forEach(([path, val]) => {
                updates[path] = val
            })
        }

        // 4. Commit to Firebase
        await update(ref(db), updates)

        return NextResponse.json({ success: true })
    } catch (e: any) {
        console.error('Start Game Error:', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}
