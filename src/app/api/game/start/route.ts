import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, get, update } from 'firebase/database'
import { MaskedSongItem, prepareGamePayload, SongItem } from '@/lib/game-logic'
import { buildWhoSangThatExtra } from '@/lib/who-sang-that'
import { getArtistMetadataBatch } from '@/lib/artist-metadata'
import { asyncPool } from '@/lib/async-utils'

const WHO_SANG_THAT_RECENT_OPTION_LIMIT = 15

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
                await update(ref(db, `rooms/${roomCode}`), {
                    creation_progress: percent
                })
            }
        )

        // 1.5 Refresh Deezer Previews before starting the game
        const BATCH_SIZE = 10;
        for (let i = 0; i < playlist.length; i += BATCH_SIZE) {
            const batch = playlist.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (song) => {
                // In your spotify.ts, the Deezer ID is currently being saved to the spotify_uri field
                if (!song.spotify_uri) return;
                try {
                    // Strict 2.5 second timeout to guarantee game start never hangs
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 2500);
                    
                    const res = await fetch(`https://api.deezer.com/track/${song.spotify_uri}`, { signal: controller.signal });
                    clearTimeout(timeoutId);
                    
                    if (!res.ok) return;
                    const data = await res.json();
                    
                    if (data.preview) {
                        song.preview_url = data.preview;
                        // Ensure the fresh URL is also saved to the main room songs object
                        updates[`rooms/${roomCode}/songs/${song.id}/preview_url`] = data.preview;
                    }
                } catch (e) {
                    console.error(`Failed to refresh Deezer preview for ID ${song.spotify_uri}`, e);
                }
            }));
        }

        // 2. Separate Secrets & Mask Public Data
        const secrets: Record<string, SongItem> = {}
        const maskedPlaylist: MaskedSongItem[] = []

        const isAlbumArt = settings.mode === 'album_art'

        playlist.forEach((song, index) => {
            secrets[index] = song

            maskedPlaylist.push({
                id: song.id,
                picked_by_user_id: song.picked_by_user_id,
                preview_url: isAlbumArt ? null : (song.preview_url || null),
                artist_name: '???',
                track_name: '???',
                cover_url: isAlbumArt ? (song.album_cover_url || song.cover_url) : '',
                spotify_uri: song.spotify_uri || ''
            })
        })

        if (updates[`rooms/${roomCode}/game_state`]) {
            updates[`rooms/${roomCode}/game_state`].playlist = maskedPlaylist
        }

        updates[`room_secrets/${roomCode}`] = secrets

        // 3. Lyrics Handling (Server Side Prefetch) - ALL ROUNDS PARALLEL
        if (settings.mode === 'lyrics_only') {
            const lyricsUpdates: Record<string, string> = {}
            
            await asyncPool(3, playlist, async (song: SongItem) => {
                try {
                    const apiUrl = new URL(request.url).origin + `/api/lyrics?artist=${encodeURIComponent(song.artist_name)}&title=${encodeURIComponent(song.track_name)}`
                    const res = await fetch(apiUrl)
                    const data = await res.json()
                    if (data.lyrics) {
                        lyricsUpdates[`rooms/${roomCode}/lyrics_cache/${song.id}`] = data.lyrics
                    }
                } catch {
                    // Ignore prefetch failures
                }
            })

            Object.entries(lyricsUpdates).forEach(([path, val]) => {
                updates[path] = val
            })
        }

        // 3b. Who Sang That - Parallel Generation
        if (settings.mode === 'who_sang_that') {
            // Fetch ALL songs in the room to have a wider distractor pool
            const roomSongsSnap = await get(ref(db, `rooms/${roomCode}/songs`))
            const roomSongs = Object.values(roomSongsSnap.val() || {}) as SongItem[]

            // Group by artist to gather titles for language inference
            const artistGroups = new Map<string, { name: string; spotify_artist_id?: string | null; titles: string[] }>()
            roomSongs.forEach(song => {
                if (!song.artist_name) return
                const key = song.artist_name.toLowerCase().trim()
                if (!artistGroups.has(key)) {
                    artistGroups.set(key, { 
                        name: song.artist_name, 
                        spotify_artist_id: song.spotify_artist_id || null,
                        titles: [] 
                    })
                }
                artistGroups.get(key)!.titles.push(song.track_name)
            })

            // Enrich with Metadata (Persistent Cache + Spotify + Inference)
            const metadataMap = await getArtistMetadataBatch(Array.from(artistGroups.values()))

            const artistPool = Array.from(artistGroups.values()).map(a => {
                const meta = metadataMap[a.name]
                return {
                    name: a.name,
                    spotify_artist_id: a.spotify_artist_id ?? null,
                    _lang: meta?.lang || 'en',
                    _genres: meta?.genres || []
                }
            })
            
            // To maintain the 'recentOptionNames' logic while parallelizing, 
            // we can still build in batches, or just accept slightly looser deduplication for speed.
            // Speed is the priority here.
            const recentOptionNames: string[] = []

            await asyncPool(3, playlist, async (song: SongItem) => {
                const cached = updates[`rooms/${roomCode}/lyrics_cache/${song.id}`] as string | undefined
                const { extra, lyricsText } = await buildWhoSangThatExtra(song, artistPool, cached ?? null, recentOptionNames)

                if (lyricsText && !cached) {
                    updates[`rooms/${roomCode}/lyrics_cache/${song.id}`] = lyricsText
                }

                updates[`rooms/${roomCode}/who_sang_that_extras/${song.id}`] = extra

                // Note: sequential recent update is lost in true parallel, but for batches of 3 it's acceptable.
                extra.options.forEach(opt => {
                    if (!recentOptionNames.includes(opt.name)) {
                        recentOptionNames.push(opt.name)
                    }
                })
                if (recentOptionNames.length > WHO_SANG_THAT_RECENT_OPTION_LIMIT) {
                    recentOptionNames.splice(0, recentOptionNames.length - WHO_SANG_THAT_RECENT_OPTION_LIMIT)
                }
            })
        }

        // 4. Commit to Firebase
        await update(ref(db), updates)

        return NextResponse.json({ success: true })
    } catch (e: unknown) {
        console.error('Start Game Error:', e)
        const message = e instanceof Error ? e.message : 'Unknown error'
        return NextResponse.json({ error: message }, { status: 500 })
    }
}
