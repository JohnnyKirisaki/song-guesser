import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, get, update } from 'firebase/database'
import { MaskedSongItem, prepareGamePayload, SongItem } from '@/lib/game-logic'
import { buildWhoSangThatExtra } from '@/lib/who-sang-that'
import { getArtistMetadataBatch } from '@/lib/artist-metadata'
import { asyncPool } from '@/lib/async-utils'
import { pickLyricCompletionPair, generateEmojiPuzzle } from '@/lib/new-mode-extras'
import { fetchLyrics } from '@/lib/lyrics'

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

        // Mixed mode: assign a random sub-mode to each song, filtered by what
        // metadata is available. chill_rating is intentionally excluded — it's
        // a rating-based mode with no "correct answer", so mixing it in would
        // give players free points in a competitive game.
        const MIXED_POOL: string[] = [
            'normal', 'artist_only', 'song_only', 'lyrics_only',
            'guess_who', 'who_sang_that', 'album_art', 'year_guesser',
            'buzzer', 'lyric_completion', 'emoji_charades', 'snippet_reveal'
        ]
        const pickModeForSong = (song: SongItem, _index: number): string => {
            const eligible = MIXED_POOL.filter(m => {
                if (m === 'year_guesser' && typeof song.release_year !== 'number') return false
                if (m === 'album_art' && !song.album_cover_url && !song.cover_url) return false
                // lyrics_only / who_sang_that / lyric_completion may fail lyrics
                // lookup; reveal route has a replacement path.
                return true
            })
            const pool = eligible.length > 0 ? eligible : ['normal']
            return pool[Math.floor(Math.random() * pool.length)]
        }

        const isMixed = settings.mode === 'mixed'

        playlist.forEach((song, index) => {
            // Stamp per-round mode BEFORE secrets get written so the reveal
            // route sees it on the secret payload too.
            if (isMixed) {
                song.round_mode = pickModeForSong(song, index)
            }
            secrets[index] = song

            const effectiveMode = song.round_mode || settings.mode
            const isAlbumArtRound = effectiveMode === 'album_art'
            // lyric_completion asks the player to finish the next line — the
            // song itself isn't the puzzle, so leaking artist/title is fine
            // (and actually necessary: players need to know what song they're
            // completing). Everything else stays masked.
            const isLyricCompletionRound = effectiveMode === 'lyric_completion'

            maskedPlaylist.push({
                id: song.id,
                picked_by_user_id: song.picked_by_user_id,
                preview_url: isAlbumArtRound ? null : (song.preview_url || null),
                artist_name: isLyricCompletionRound ? song.artist_name : '???',
                track_name: isLyricCompletionRound ? song.track_name : '???',
                cover_url: isAlbumArtRound ? (song.album_cover_url || song.cover_url) : '',
                spotify_uri: song.spotify_uri || '',
                // Public — clients need to know which sub-mode this round is
                round_mode: song.round_mode || null
            })
        })

        if (updates[`rooms/${roomCode}/game_state`]) {
            updates[`rooms/${roomCode}/game_state`].playlist = maskedPlaylist
        }

        updates[`room_secrets/${roomCode}`] = secrets

        // --- Emoji Charades: generate emoji-string per song, publish under extras
        // so clients can show the prompt without seeing the answer. Emojis are
        // deterministic from title so generation is cheap and skippable on retry.
        const emojiTargets = settings.mode === 'emoji_charades'
            ? playlist
            : (isMixed ? playlist.filter(s => s.round_mode === 'emoji_charades') : [])
        if (emojiTargets.length > 0) {
            // Use Gemini for semantic title→emoji; falls back to the local
            // dictionary when the API key is absent or the call fails.
            // Run serially (pool=1) to stay under Gemini free-tier RPM limits —
            // generateEmojiPuzzle already retries 429s with backoff, but
            // bursting 5+ parallel requests routinely hits the quota.
            await asyncPool(1, emojiTargets, async (song: SongItem) => {
                const emojis = await generateEmojiPuzzle(song.track_name, song.artist_name)
                updates[`rooms/${roomCode}/emoji_charades_extras/${song.id}`] = { emojis }
            })
        }

        // --- Lyric Completion: fetch lyrics with per-song timeout, pick a
        // challenge/answer pair, publish challenge publicly and answer in a
        // server-only bucket so reveal can score it.
        const lyricCompletionTargets = settings.mode === 'lyric_completion'
            ? playlist
            : (isMixed ? playlist.filter(s => s.round_mode === 'lyric_completion') : [])
        if (lyricCompletionTargets.length > 0) {
            await asyncPool(3, lyricCompletionTargets, async (song: SongItem) => {
                try {
                    const lyrics = await fetchLyrics(song.artist_name, song.track_name)
                    if (!lyrics) return
                    const pair = pickLyricCompletionPair(lyrics)
                    if (!pair) return
                    // challenge (the line shown) is public. answer stays in a
                    // server-only path so malicious clients can't just read it.
                    updates[`rooms/${roomCode}/lyric_completion_extras/${song.id}`] = { challenge: pair.challenge }
                    updates[`lyric_completion_secrets/${roomCode}/${song.id}`] = { answer: pair.answer }
                } catch (e) {
                    console.warn(`[LyricCompletion] prefetch failed for ${song.artist_name} - ${song.track_name}:`, e)
                }
            })
        }

        // 3. Lyrics Handling (Server Side Prefetch) - parallel with per-song
        // timeout so one slow upstream never hangs game start. Also caps total
        // wall-clock regardless of how many songs time out.
        // In mixed mode, only prefetch for songs whose randomly-assigned round
        // is lyrics_only — we don't need every song's lyrics.
        const lyricsTargets = settings.mode === 'lyrics_only'
            ? playlist
            : (isMixed ? playlist.filter(s => s.round_mode === 'lyrics_only') : [])
        if (lyricsTargets.length > 0) {
            const lyricsUpdates: Record<string, string> = {}
            const PER_SONG_TIMEOUT_MS = 4000
            const OVERALL_TIMEOUT_MS = 15_000

            const fetchOne = async (song: SongItem) => {
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), PER_SONG_TIMEOUT_MS)
                try {
                    const apiUrl = new URL(request.url).origin + `/api/lyrics?artist=${encodeURIComponent(song.artist_name)}&title=${encodeURIComponent(song.track_name)}`
                    const res = await fetch(apiUrl, { signal: controller.signal })
                    const data = await res.json()
                    if (data.lyrics) {
                        lyricsUpdates[`rooms/${roomCode}/lyrics_cache/${song.id}`] = data.lyrics
                    }
                } catch {
                    // Ignore prefetch failures (including timeouts)
                } finally {
                    clearTimeout(timer)
                }
            }

            // Pool + Promise.race with overall cap — whichever finishes first wins.
            await Promise.race([
                (async () => {
                    const results = await Promise.allSettled(
                        // asyncPool caps concurrency at 3; allSettled so one
                        // rejection doesn't poison the batch.
                        [asyncPool(3, lyricsTargets, fetchOne)]
                    )
                    void results
                })(),
                new Promise<void>(resolve => setTimeout(() => {
                    console.warn('[Lyrics Prefetch] Overall timeout hit; proceeding with partial cache')
                    resolve()
                }, OVERALL_TIMEOUT_MS))
            ])

            Object.entries(lyricsUpdates).forEach(([path, val]) => {
                updates[path] = val
            })
        }

        // 3b. Who Sang That - Parallel Generation
        // In mixed mode, only build extras for songs whose randomly-assigned
        // round is who_sang_that.
        const wstTargets = settings.mode === 'who_sang_that'
            ? playlist
            : (isMixed ? playlist.filter(s => s.round_mode === 'who_sang_that') : [])
        if (wstTargets.length > 0) {
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

            await asyncPool(3, wstTargets, async (song: SongItem) => {
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
