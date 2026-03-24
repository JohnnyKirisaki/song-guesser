import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, update } from 'firebase/database'
import { MaskedSongItem, prepareGamePayload, SongItem } from '@/lib/game-logic'
import { buildWhoSangThatExtra } from '@/lib/who-sang-that'

const WHO_SANG_THAT_RECENT_OPTION_LIMIT = 6

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

        // 3. Lyrics Handling (Server Side Prefetch)
        if (settings.mode === 'lyrics_only') {
            const lyricsUpdates: Record<string, string> = {}
            const initialBatch = playlist.slice(0, 3)

            await Promise.all(initialBatch.map(async (song) => {
                try {
                    const apiUrl = new URL(request.url).origin + `/api/lyrics?artist=${encodeURIComponent(song.artist_name)}&title=${encodeURIComponent(song.track_name)}`
                    const res = await fetch(apiUrl)
                    const data = await res.json()
                    if (data.lyrics) {
                        lyricsUpdates[`rooms/${roomCode}/lyrics_cache/${song.id}`] = data.lyrics
                    }
                } catch {
                    // Ignore prefetch failures and rely on reveal-time recovery.
                }
            }))

            Object.entries(lyricsUpdates).forEach(([path, val]) => {
                updates[path] = val
            })
        }

        // 3b. Who Sang That - build lyrics excerpts + artist photo options
        if (settings.mode === 'who_sang_that') {
            const artistPool = Array.from(new Map(
                playlist
                    .map(song => ({
                        name: song.artist_name,
                        spotify_artist_id: song.spotify_artist_id ?? null
                    }))
                    .filter((artist) => !!artist.name)
                    .map((artist) => [artist.name.toLowerCase(), artist])
            ).values())
            const recentOptionNames: string[] = []

            for (const song of playlist) {
                const cached = updates[`rooms/${roomCode}/lyrics_cache/${song.id}`] as string | undefined
                const { extra, lyricsText } = await buildWhoSangThatExtra(song, artistPool, cached ?? null, recentOptionNames)

                if (lyricsText && !cached) {
                    updates[`rooms/${roomCode}/lyrics_cache/${song.id}`] = lyricsText
                }

                updates[`rooms/${roomCode}/who_sang_that_extras/${song.id}`] = extra

                recentOptionNames.push(...extra.options.map(option => option.name))
                if (recentOptionNames.length > WHO_SANG_THAT_RECENT_OPTION_LIMIT) {
                    recentOptionNames.splice(0, recentOptionNames.length - WHO_SANG_THAT_RECENT_OPTION_LIMIT)
                }
            }
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
