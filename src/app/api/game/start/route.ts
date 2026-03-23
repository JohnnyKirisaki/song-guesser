import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, update } from 'firebase/database'
import { prepareGamePayload, SongItem } from '@/lib/game-logic'
import { fetchDeezerArtistPhoto } from '@/lib/deezer'
import { fetchLyrics } from '@/lib/lyrics'

function extractLyricsExcerpt(lyrics: string): string[] {
    const FILLER_RE = /^(oh+|ah+|na+|la+|hey+|yeah+|uh+|mm+|hm+|woo+|ay+|yea+|ooh+|bah+|da+|doo+|sha+|bay+|whoa+|hmm+|mmm+|ohh+|yeh+|nah+|aye+|woah+|ooo+)[\s,!?.~\-*]*$/i
    const cleanLines = lyrics.split('\n').map(l => l.trim()).filter(l => {
        if (!l || l.length < 10) return false
        if (l.startsWith('[') || l.startsWith('(')) return false
        const words = l.split(/\s+/).filter(w => w.length > 0)
        if (words.length < 3) return false
        const nonFiller = words.filter(w => !FILLER_RE.test(w))
        return nonFiller.length >= 2
    })
    if (cleanLines.length === 0) return []
    if (cleanLines.length === 1) return [cleanLines[0]]
    const startIdx = Math.max(0, Math.floor(cleanLines.length * 0.2))
    const endIdx = Math.min(cleanLines.length - 2, Math.floor(cleanLines.length * 0.65))
    const pickIdx = endIdx > startIdx
        ? startIdx + Math.floor(Math.random() * (endIdx - startIdx + 1))
        : startIdx
    return [cleanLines[pickIdx], cleanLines[Math.min(pickIdx + 1, cleanLines.length - 1)]]
}

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
                picked_by_user_id: song.picked_by_user_id || null,
                preview_url: song.preview_url || null,
                // Mask the rest
                artist_name: '???',
                track_name: '???',
                cover_url: '',
                spotify_uri: song.spotify_uri || '' // Unmasked to allow ID-based audio refresh
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

        // 3b. Who Sang That — build lyrics excerpts + artist photo options
        if (settings.mode === 'who_sang_that') {
            // Build pool of unique artist names across the playlist
            const artistPool = [...new Set(playlist.map(s => s.artist_name))]

            // Process songs with moderate parallelism (4 at a time to avoid rate limiting)
            const CONCURRENCY = 4
            for (let i = 0; i < playlist.length; i += CONCURRENCY) {
                const batch = playlist.slice(i, i + CONCURRENCY)
                await Promise.all(batch.map(async (song) => {
                    // 1. Try to get lyrics excerpt from cache
                    let excerpt: string[] = []
                    const cached = updates[`rooms/${roomCode}/lyrics_cache/${song.id}`] as string | undefined
                    const lyricsText = cached || await fetchLyrics(song.artist_name, song.track_name).catch(() => null)
                    if (lyricsText) {
                        excerpt = extractLyricsExcerpt(lyricsText)
                        if (!cached) {
                            updates[`rooms/${roomCode}/lyrics_cache/${song.id}`] = lyricsText
                        }
                    }

                    // 2. Pick an imposter artist (different from correct)
                    const FALLBACK_ARTISTS = ['Taylor Swift', 'Drake', 'Beyoncé', 'Ed Sheeran', 'Ariana Grande', 'The Weeknd', 'Bad Bunny', 'Billie Eilish']
                    const imposters = artistPool.filter(a => a.toLowerCase() !== song.artist_name.toLowerCase())
                    const imposterPool = imposters.length > 0 ? imposters : FALLBACK_ARTISTS.filter(a => a.toLowerCase() !== song.artist_name.toLowerCase())
                    const imposterName = imposterPool.length > 0
                        ? imposterPool[Math.floor(Math.random() * imposterPool.length)]
                        : 'Unknown Artist'

                    // 3. Fetch Deezer artist photos in parallel
                    const [correctPhoto, imposterPhoto] = await Promise.all([
                        fetchDeezerArtistPhoto(song.artist_name).catch(() => null),
                        fetchDeezerArtistPhoto(imposterName).catch(() => null)
                    ])

                    // 4. Shuffle options (so correct isn't always first)
                    const correct = { name: song.artist_name, photo: correctPhoto }
                    const imposter = { name: imposterName, photo: imposterPhoto }
                    const options = Math.random() < 0.5 ? [correct, imposter] : [imposter, correct]

                    updates[`rooms/${roomCode}/who_sang_that_extras/${song.id}`] = { excerpt, options }
                }))
            }
        }

        // 4. Commit to Firebase
        await update(ref(db), updates)

        return NextResponse.json({ success: true })
    } catch (e: any) {
        console.error('Start Game Error:', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}
