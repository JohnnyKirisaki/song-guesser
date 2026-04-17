import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, get, update, serverTimestamp } from 'firebase/database'
import { calculateScore, isMatch } from '@/lib/scoring'
import { GameState, SongItem } from '@/lib/game-logic'
import { fetchLyrics } from '@/lib/lyrics'
import { resolvePlaylist } from '@/lib/deezer'
import { buildWhoSangThatExtra } from '@/lib/who-sang-that'

const WHO_SANG_THAT_RECENT_OPTION_LIMIT = 6

function getRecentOptionNames(
    playlist: SongItem[],
    existingExtras: Record<string, { options?: Array<{ name?: string }> }>,
    roundIndex: number
): string[] {
    const recent: string[] = []

    for (let index = Math.max(0, roundIndex - 3); index < roundIndex; index++) {
        const song = playlist[index]
        if (!song?.id) continue

        const options = existingExtras[song.id]?.options || []
        recent.push(...options.map(option => option?.name).filter((name): name is string => !!name))
    }

    return recent.slice(-WHO_SANG_THAT_RECENT_OPTION_LIMIT)
}

export async function POST(request: Request) {
    try {
        const { roomCode, roundIndex } = await request.json()

        if (!roomCode || roundIndex === undefined) {
            return NextResponse.json({ error: 'Missing params' }, { status: 400 })
        }

        // 1. Fetch Room Data (Secrets, Players, Settings, GameState)
        const roomRef = ref(db, `rooms/${roomCode}`)
        const secretRef = ref(db, `room_secrets/${roomCode}/${roundIndex}`)

        const [roomSnap, secretSnap] = await Promise.all([
            get(roomRef),
            get(secretRef)
        ])

        if (!roomSnap.exists()) return NextResponse.json({ error: 'Room not found' }, { status: 404 })
        if (!secretSnap.exists()) return NextResponse.json({ error: 'Secret not found' }, { status: 404 })

        const roomData = roomSnap.val()
        const fullSong = secretSnap.val() as SongItem
        const gameState = roomData?.game_state as GameState | undefined

        // Runtime guards — Firebase data can be partial if a write landed mid-operation
        // or if schema has drifted. Fail with clear 4xx/5xx rather than crashing below.
        if (!fullSong || typeof fullSong !== 'object' || !fullSong.id) {
            console.error(`[Reveal] Malformed secret payload for room ${roomCode} round ${roundIndex}`, fullSong)
            return NextResponse.json({ error: 'Malformed song secret' }, { status: 500 })
        }
        if (!gameState || typeof gameState !== 'object' || !Array.isArray(gameState.playlist)) {
            console.error(`[Reveal] Malformed game_state for room ${roomCode}`, gameState)
            return NextResponse.json({ error: 'Malformed game state' }, { status: 500 })
        }

        const players = roomData.players ? Object.values(roomData.players) as any[] : []
        const settings = roomData.settings
        const allSongs = Object.values(roomData.songs || {}) as SongItem[]

        // 2. Calculate Scores
        const updates: Record<string, any> = {}
        const roundGuesses: any[] = []

        const totalTime = settings?.time || 15
        const mode = settings?.mode || 'normal'
        console.log(`[Reveal] Start. Room: ${roomCode}, Round: ${roundIndex}, Mode: ${mode}`)
        const revealStart = Date.now()
        const isSuddenDeath = !!gameState.is_sudden_death
        const usedSongIds = new Set((gameState.playlist || []).map((s: any) => s.id).filter(Boolean))

        const normalizePreviewUrl = (url: string) => url.replace(/^http:\/\//i, 'https://').trim()
        const isValidPreview = (url?: string | null) => {
            if (typeof url !== 'string' || !url.trim().startsWith('http')) return false
            const expMatch = url.match(/exp=(\d+)/)
            if (expMatch) {
                const expTime = parseInt(expMatch[1], 10)
                const nowSeconds = Math.floor(Date.now() / 1000)
                // Require at least 2 minutes of validity
                if (expTime < nowSeconds + 120) return false
            }
            return true
        }

        const buildMaskedPlaylistEntry = (song: SongItem) => ({
            id: song.id,
            picked_by_user_id: song.picked_by_user_id,
            preview_url: song.preview_url,
            artist_name: '???',
            track_name: '???',
            cover_url: '',
            spotify_uri: '' // Masked
        })

        const applySongAtIndex = (index: number, song: SongItem) => {
            updates[`room_secrets/${roomCode}/${index}`] = song
            const playlistEntry = isSuddenDeath ? buildMaskedPlaylistEntry(song) : song
            updates[`rooms/${roomCode}/game_state/playlist/${index}`] = playlistEntry
        }

        const resolvePreviewForSong = async (song: SongItem): Promise<{ preview_url: string, deezerId?: string } | null> => {
            try {
                const resolved = await resolvePlaylist([{ artist: song.artist_name, title: song.track_name }])
                const match = resolved.find(r => r.resolved && r.deezer?.preview_url)
                if (!match?.deezer?.preview_url) return null
                return {
                    preview_url: normalizePreviewUrl(match.deezer.preview_url),
                    deezerId: match.deezer.id
                }
            } catch (e) {
                console.error('[Audio] Resolve preview failed:', e)
                return null
            }
        }

        const isDeezerId = (id?: string | null) => typeof id === 'string' && /^\d+$/.test(id)

        const ensurePreviewForSong = async (
            song: SongItem,
            index?: number,
            forceResolve = false
        ): Promise<SongItem> => {
            if (!forceResolve && isValidPreview(song.preview_url)) return song
            if (!forceResolve && isDeezerId(song.spotify_uri) && isValidPreview(song.preview_url)) return song
            const resolved = await resolvePreviewForSong(song)
            if (!resolved) return song

            const updated: SongItem = {
                ...song,
                preview_url: resolved.preview_url,
                spotify_uri: resolved.deezerId || song.spotify_uri
            }

            updates[`rooms/${roomCode}/songs/${song.id}/preview_url`] = updated.preview_url
            if (resolved.deezerId) {
                updates[`rooms/${roomCode}/songs/${song.id}/spotify_uri`] = resolved.deezerId
            }

            if (index !== undefined) {
                updates[`room_secrets/${roomCode}/${index}/preview_url`] = updated.preview_url
                if (resolved.deezerId) {
                    updates[`room_secrets/${roomCode}/${index}/spotify_uri`] = resolved.deezerId
                }
                updates[`rooms/${roomCode}/game_state/playlist/${index}/preview_url`] = updated.preview_url
                if (!isSuddenDeath && resolved.deezerId) {
                    updates[`rooms/${roomCode}/game_state/playlist/${index}/spotify_uri`] = resolved.deezerId
                }
            }

            return updated
        }

        const findReplacementWithLyrics = async (): Promise<{ song: SongItem, lyrics: string } | null> => {
            const pool = allSongs.filter(s => !usedSongIds.has(s.id)).sort(() => 0.5 - Math.random()).slice(0, 3)
            if (pool.length === 0) return null

            // Fetch lyrics for all candidates simultaneously — first success wins
            const attempts = pool.map(async (candidate) => {
                const l = await fetchLyrics(candidate.artist_name, candidate.track_name)
                if (!l) throw new Error('no lyrics')
                return { song: candidate, lyrics: l }
            })

            try {
                const result = await Promise.any(attempts)
                usedSongIds.add(result.song.id)
                return result
            } catch {
                console.log('[Reveal] No replacement found with lyrics in 3 candidates.')
                return null
            }
        }

        const roundStartRaw = gameState.round_start_time
        const roundStartMs = typeof roundStartRaw === 'number'
            ? roundStartRaw
            : roundStartRaw
                ? new Date(roundStartRaw).getTime()
                : 0

        // Helper to check if player is active in this round
        const isPlayerActive = (pid: string) => {
            if (!isSuddenDeath) return true
            return (gameState.dueling_player_ids || []).includes(pid)
        }

        // Spectators are present in the players map so the spectator count is
        // visible, but they never score. Also sweep any slot that's been
        // disconnected past the 60s grace window — they forfeit this round's
        // scoring but stay in the map until they reconnect or a fresh round
        // clears them via a different path.
        const DISCONNECT_GRACE_MS = 60_000
        const now = Date.now()
        const isParticipating = (p: any): boolean => {
            if (p?.is_spectator) return false
            const discRaw = p?.disconnected_at
            if (discRaw) {
                const discMs = typeof discRaw === 'number' ? discRaw : new Date(discRaw).getTime()
                if (Number.isFinite(discMs) && now - discMs > DISCONNECT_GRACE_MS) {
                    return false
                }
            }
            return true
        }

        players.forEach(p => {
            // Default: Clear stats
            let points = 0
            let correctTitle = false
            let correctArtist = false
            let clampedTimeTaken = totalTime

            // Server-side hard cap to defend against malicious clients writing
            // oversized strings directly into Firebase (~100 chars matches
            // realistic song/artist names; 1KB is still well below DB abuse).
            const MAX_GUESS_LEN = 100
            const rawGuess = p.last_guess || { artist: '', title: '' }
            const g = {
                ...(typeof rawGuess === 'object' ? rawGuess : {}),
                artist: typeof rawGuess?.artist === 'string' ? rawGuess.artist.slice(0, MAX_GUESS_LEN) : '',
                title: typeof rawGuess?.title === 'string' ? rawGuess.title.slice(0, MAX_GUESS_LEN) : ''
            }

            // Only calculate real score if active, not a spectator, and not past grace
            if (isPlayerActive(p.id) && isParticipating(p)) {
                const submittedRaw = p.submitted_at
                const submittedAtMs = typeof submittedRaw === 'number'
                    ? submittedRaw
                    : submittedRaw
                        ? new Date(submittedRaw).getTime()
                        : null

                const timeTaken = (submittedAtMs && roundStartMs)
                    ? Math.max(0, (submittedAtMs - roundStartMs) / 1000)
                    : totalTime
                clampedTimeTaken = Math.min(totalTime, timeTaken)
                const timeLeftForPlayer = Math.max(0, totalTime - clampedTimeTaken)

                if (mode === 'guess_who') {
                    // Guess Who: player guesses who added the song (picked_by_user_id stored in title field)
                    correctTitle = !!fullSong.picked_by_user_id && g.title === fullSong.picked_by_user_id
                    correctArtist = false
                    points = correctTitle ? 1 : 0
                } else if (mode === 'who_sang_that') {
                    // Who Sang That: player guesses the artist from lyrics (artist name stored in title field)
                    correctTitle = !!g.title && g.title.toLowerCase().trim() === fullSong.artist_name.toLowerCase().trim()
                    correctArtist = false
                    points = correctTitle ? 1 : 0
                } else if (mode === 'album_art') {
                    // Album Art: guess.title = album name, guess.artist = artist name
                    const albumAnswer = fullSong.album_name || fullSong.track_name // fallback to track name if no album
                    correctTitle = isMatch(g.title, albumAnswer, false)
                    correctArtist = isMatch(g.artist, fullSong.artist_name, true)
                    const scoreData = calculateScore(
                        { artist: g.artist, title: g.title },
                        { artist: fullSong.artist_name, title: albumAnswer },
                        timeLeftForPlayer,
                        totalTime,
                        mode,
                        isSuddenDeath
                    )
                    points = scoreData.points
                } else if (mode === 'chill_rating') {
                    // Chill Rating: no points, but we save the rating (1-10) which is stored in title
                    correctTitle = false
                    correctArtist = false
                    points = 0
                } else if (mode === 'year_guesser') {
                    // Year Guesser: guess.title holds the year the player typed in.
                    // The answer comes from fullSong.release_year (captured at import
                    // time). We pass year-as-string into calculateScore via the
                    // `title` field so the schema stays consistent with other modes.
                    const answerYear = typeof fullSong.release_year === 'number'
                        ? fullSong.release_year
                        : null
                    if (answerYear == null) {
                        // Missing metadata → no points possible, don't penalize
                        points = 0
                        correctTitle = false
                        correctArtist = false
                    } else {
                        const scoreData = calculateScore(
                            { artist: '', title: g.title },
                            { artist: '', title: String(answerYear) },
                            timeLeftForPlayer,
                            totalTime,
                            mode,
                            isSuddenDeath
                        )
                        points = scoreData.points
                        correctTitle = scoreData.correctTitle
                        correctArtist = false
                    }
                } else {
                    const scoreData = calculateScore(
                        { artist: g.artist, title: g.title },
                        { artist: fullSong.artist_name, title: fullSong.track_name },
                        timeLeftForPlayer,
                        totalTime,
                        mode,
                        isSuddenDeath
                    )
                    points = scoreData.points
                    correctTitle = scoreData.correctTitle
                    correctArtist = scoreData.correctArtist
                }
            }

            // Update Player Stats
            if (isSuddenDeath) {
                const oldSD = p.sudden_death_score || 0
                // Only add points if active (stats cleared otherwise implies 0 points this round)
                updates[`rooms/${roomCode}/players/${p.id}/sudden_death_score`] = oldSD + points
            } else {
                updates[`rooms/${roomCode}/players/${p.id}/score`] = (p.score || 0) + points
            }

            updates[`rooms/${roomCode}/players/${p.id}/last_round_points`] = points
            updates[`rooms/${roomCode}/players/${p.id}/last_round_correct_artist`] = correctArtist
            updates[`rooms/${roomCode}/players/${p.id}/last_round_correct_title`] = correctTitle
            updates[`rooms/${roomCode}/players/${p.id}/last_round_time_taken`] = clampedTimeTaken
            updates[`rooms/${roomCode}/players/${p.id}/last_round_index`] = roundIndex

            roundGuesses.push({
                user_id: p.id,
                username: p.username,
                avatar_url: p.avatar_url,
                guess_title: g.title || '',
                guess_artist: g.artist || '',
                correct_title: correctTitle,
                correct_artist: correctArtist,
                is_correct: correctTitle || correctArtist,
                points: points,
                time_taken: clampedTimeTaken
            })
        })

        // 3. Update Game State (Reveal Answer)
        updates[`rooms/${roomCode}/game_state/current_round_answer`] = {
            artist: fullSong.artist_name,
            title: fullSong.track_name,
            cover_url: fullSong.album_cover_url || fullSong.cover_url,
            album_name: fullSong.album_name || null,
            release_year: typeof fullSong.release_year === 'number' ? fullSong.release_year : null
        }

        // Backfill playlist item for history consistency
        updates[`rooms/${roomCode}/game_state/playlist/${roundIndex}/artist_name`] = fullSong.artist_name
        updates[`rooms/${roomCode}/game_state/playlist/${roundIndex}/track_name`] = fullSong.track_name
        updates[`rooms/${roomCode}/game_state/playlist/${roundIndex}/cover_url`] = fullSong.album_cover_url || fullSong.cover_url

        // Phase Change
        updates[`rooms/${roomCode}/game_state/phase`] = 'reveal'
        updates[`rooms/${roomCode}/game_state/reveal_start_time`] = serverTimestamp()
        updates[`rooms/${roomCode}/game_state/force_reveal_at`] = null

        // 4. Save History
        updates[`rooms/${roomCode}/round_history/${roundIndex}`] = {
            round_index: roundIndex,
            song_id: fullSong.id,
            track_name: fullSong.track_name,
            artist_name: fullSong.artist_name,
            cover_url: fullSong.cover_url,
            picked_by_user_id: fullSong.picked_by_user_id,
            started_at: gameState.round_start_time || null,
            ended_at: serverTimestamp(),
            guesses: roundGuesses,
            is_sudden_death: isSuddenDeath
        }

        // 5. Lyrics (JIT Caching)
        if (settings?.mode === 'lyrics_only') {
            try {
                if (isSuddenDeath) {
                    // In sudden death, prefetch lyrics in chunks of 5 (not every round).
                    const chunkSize = 5
                    const sdStartIndex = gameState.sudden_death_start_index

                    if (sdStartIndex !== undefined && roundIndex >= sdStartIndex) {
                        const sdRound = roundIndex - sdStartIndex
                        const shouldPrefetch = (sdRound + 1) % chunkSize === 0

                        if (shouldPrefetch) {
                            const indices = Array.from({ length: chunkSize }, (_, i) => roundIndex + 1 + i)
                            await Promise.all(indices.map(async (idx) => {
                                const secretRef = ref(db, `room_secrets/${roomCode}/${idx}`)
                                const secretSnap = await get(secretRef)
                                if (!secretSnap.exists()) return
                                const nextSong = secretSnap.val() as SongItem
                                if (!nextSong?.id || !nextSong.artist_name || !nextSong.track_name) return

                                const cacheRef = ref(db, `rooms/${roomCode}/lyrics_cache/${nextSong.id}`)
                                const cacheSnap = await get(cacheRef)
                                if (!cacheSnap.exists()) {
                                    const l = await fetchLyrics(nextSong.artist_name, nextSong.track_name)
                                    if (l) {
                                        updates[`rooms/${roomCode}/lyrics_cache/${nextSong.id}`] = l
                                        await ensurePreviewForSong(nextSong, idx, true)
                                    } else {
                                        const replacement = await findReplacementWithLyrics()
                                        if (replacement) {
                                            const updated = await ensurePreviewForSong(replacement.song, idx, true)
                                            applySongAtIndex(idx, updated)
                                            updates[`rooms/${roomCode}/lyrics_cache/${replacement.song.id}`] = replacement.lyrics
                                        }
                                    }
                                } else {
                                    await ensurePreviewForSong(nextSong, idx, true)
                                }
                            }))
                        }
                    }
                } else {
                    // Normal lyrics mode: cache lyrics for NEXT round + sanity check current
                    const nextRoundIndex = roundIndex + 1
                    const nextSecretRef = ref(db, `room_secrets/${roomCode}/${nextRoundIndex}`)
                    const nextSecretSnap = await get(nextSecretRef)

                    // Parallelize these operations
                    const promises: Promise<any>[] = []

                    // 1. Next Round Logic
                    if (nextSecretSnap.exists()) {
                        promises.push((async () => {
                            const nextSong = nextSecretSnap.val() as SongItem
                            if (!nextSong?.id || !nextSong.artist_name || !nextSong.track_name) return
                            const cacheRef = ref(db, `rooms/${roomCode}/lyrics_cache/${nextSong.id}`)
                            const cacheSnap = await get(cacheRef)

                            if (!cacheSnap.exists()) {
                                const l = await fetchLyrics(nextSong.artist_name, nextSong.track_name)
                                if (l) {
                                    updates[`rooms/${roomCode}/lyrics_cache/${nextSong.id}`] = l
                                    await ensurePreviewForSong(nextSong, nextRoundIndex, true)
                                } else {
                                    const replacement = await findReplacementWithLyrics()
                                    if (replacement) {
                                        const updated = await ensurePreviewForSong(replacement.song, nextRoundIndex, true)
                                        applySongAtIndex(nextRoundIndex, updated)
                                        updates[`rooms/${roomCode}/lyrics_cache/${replacement.song.id}`] = replacement.lyrics
                                    } else {
                                        // Fallback: If no replacement found, ensure original song has audio
                                        console.log(`[Reveal] No replacement found. Using original: ${nextSong.track_name}`)
                                        await ensurePreviewForSong(nextSong, nextRoundIndex, true)
                                    }
                                }
                            } else {
                                await ensurePreviewForSong(nextSong, nextRoundIndex, true)
                            }
                        })())
                    }

                    // 2. Current Round Sanity Check
                    promises.push((async () => {
                        const currentCacheRef = ref(db, `rooms/${roomCode}/lyrics_cache/${fullSong.id}`)
                        const currentCacheSnap = await get(currentCacheRef)
                        if (!currentCacheSnap.exists()) {
                            const l = await fetchLyrics(fullSong.artist_name, fullSong.track_name)
                            if (l) {
                                updates[`rooms/${roomCode}/lyrics_cache/${fullSong.id}`] = l
                                await ensurePreviewForSong(fullSong, roundIndex, true)
                            }
                        } else {
                            await ensurePreviewForSong(fullSong, roundIndex, true)
                        }
                    })())

                    await Promise.all(promises)
                }
            } catch (e) {
                console.error('Lyrics JIT fetch error', e)
            }
        }

        if (settings?.mode === 'who_sang_that') {
            try {
                const artistPool = Array.from(new Map(
                    allSongs
                        .map(song => ({
                            name: song.artist_name,
                            spotify_artist_id: song.spotify_artist_id ?? null
                        }))
                        .filter((artist) => !!artist.name)
                        .map((artist) => [artist.name.toLowerCase(), artist])
                ).values())
                const existingExtras = roomData.who_sang_that_extras || {}

                const ensureWhoSangThatExtras = async (song: SongItem, index?: number) => {
                    const extrasRef = ref(db, `rooms/${roomCode}/who_sang_that_extras/${song.id}`)
                    const extrasSnap = await get(extrasRef)
                    if (extrasSnap.exists()) return

                    const pendingLyricsPath = `rooms/${roomCode}/lyrics_cache/${song.id}`
                    const cachedLyrics = typeof updates[pendingLyricsPath] === 'string'
                        ? updates[pendingLyricsPath] as string
                        : typeof roomData.lyrics_cache?.[song.id] === 'string'
                            ? roomData.lyrics_cache[song.id]
                            : null
                    const recentOptionNames = index === undefined
                        ? []
                        : getRecentOptionNames(gameState.playlist || [], existingExtras, index)

                    const { extra, lyricsText } = await buildWhoSangThatExtra(song, artistPool, cachedLyrics, recentOptionNames)

                    if (!lyricsText && index !== undefined) {
                        const replacement = await findReplacementWithLyrics()
                        if (replacement) {
                            applySongAtIndex(index, replacement.song)
                            updates[`rooms/${roomCode}/lyrics_cache/${replacement.song.id}`] = replacement.lyrics

                            const replacementExtra = await buildWhoSangThatExtra(replacement.song, artistPool, replacement.lyrics, recentOptionNames)
                            updates[`rooms/${roomCode}/who_sang_that_extras/${replacement.song.id}`] = replacementExtra.extra
                            return
                        }
                    }

                    updates[`rooms/${roomCode}/who_sang_that_extras/${song.id}`] = extra
                    existingExtras[song.id] = extra

                    if (lyricsText && !cachedLyrics) {
                        updates[pendingLyricsPath] = lyricsText
                    }
                }

                await ensureWhoSangThatExtras(fullSong)

                const nextRoundIndex = roundIndex + 1
                const nextSecretSnap = await get(ref(db, `room_secrets/${roomCode}/${nextRoundIndex}`))
                if (nextSecretSnap.exists()) {
                    const nextSong = nextSecretSnap.val() as SongItem
                    if (nextSong?.id && nextSong.artist_name && nextSong.track_name) {
                        await ensureWhoSangThatExtras(nextSong, nextRoundIndex)
                    }
                }
            } catch (e) {
                console.error('Who Sang That extras fetch error', e)
            }
        }

        console.log(`[Reveal] Updates ready. Taking: ${Date.now() - revealStart}ms`)
        await update(ref(db), updates)
        console.log(`[Reveal] Done. Total: ${Date.now() - revealStart}ms`)
        return NextResponse.json({ success: true })

    } catch (error: any) {
        console.error('Reveal Error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
