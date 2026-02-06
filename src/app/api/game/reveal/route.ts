import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, get, update, serverTimestamp } from 'firebase/database'
import { calculateScore } from '@/lib/scoring'
import { GameState, SongItem } from '@/lib/game-logic'
import { fetchLyrics } from '@/lib/lyrics'
import { resolvePlaylist } from '@/lib/deezer'

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
        const gameState = roomData.game_state as GameState
        const players = roomData.players ? Object.values(roomData.players) as any[] : []
        const settings = roomData.settings
        const allSongs = Object.values(roomData.songs || {}) as SongItem[]

        // 2. Calculate Scores
        const updates: Record<string, any> = {}
        const roundGuesses: any[] = []

        const totalTime = settings?.time || 15
        const mode = settings?.mode || 'normal'
        const isSuddenDeath = !!gameState.is_sudden_death
        const usedSongIds = new Set((gameState.playlist || []).map((s: any) => s.id).filter(Boolean))

        const normalizePreviewUrl = (url: string) => url.replace(/^http:\/\//i, 'https://').trim()
        const isValidPreview = (url?: string | null) => typeof url === 'string' && url.trim().startsWith('http')

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
            const pool = allSongs.filter(s => !usedSongIds.has(s.id)).sort(() => 0.5 - Math.random())
            for (const candidate of pool) {
                const l = await fetchLyrics(candidate.artist_name, candidate.track_name)
                if (!l) continue
                usedSongIds.add(candidate.id)
                return { song: candidate, lyrics: l }
            }
            return null
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

        players.forEach(p => {
            // Default: Clear stats
            let points = 0
            let correctTitle = false
            let correctArtist = false
            let clampedTimeTaken = totalTime

            const g = p.last_guess || { artist: '', title: '' }

            // Only calculate real score if active
            if (isPlayerActive(p.id)) {
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
            cover_url: fullSong.cover_url
        }

        // Backfill playlist item for history consistency
        updates[`rooms/${roomCode}/game_state/playlist/${roundIndex}/artist_name`] = fullSong.artist_name
        updates[`rooms/${roomCode}/game_state/playlist/${roundIndex}/track_name`] = fullSong.track_name
        updates[`rooms/${roomCode}/game_state/playlist/${roundIndex}/cover_url`] = fullSong.cover_url

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
                            for (const idx of indices) {
                                const secretRef = ref(db, `room_secrets/${roomCode}/${idx}`)
                                const secretSnap = await get(secretRef)
                                if (!secretSnap.exists()) continue
                                const nextSong = secretSnap.val() as SongItem

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
                            }
                        }
                    }
                } else {
                    // Normal mode: cache lyrics for NEXT round + sanity check current
                    const nextRoundIndex = roundIndex + 1
                    const nextSecretRef = ref(db, `room_secrets/${roomCode}/${nextRoundIndex}`)
                    const nextSecretSnap = await get(nextSecretRef)

                    if (nextSecretSnap.exists()) {
                        const nextSong = nextSecretSnap.val() as SongItem
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
                                }
                            }
                        } else {
                            await ensurePreviewForSong(nextSong, nextRoundIndex, true)
                        }
                    }

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
                }
            } catch (e) {
                console.error('Lyrics JIT fetch error', e)
            }
        }

        await update(ref(db), updates)
        return NextResponse.json({ success: true })

    } catch (error: any) {
        console.error('Reveal Error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
