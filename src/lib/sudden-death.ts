import { db } from '@/lib/firebase'
import { ref, get, update, set, serverTimestamp } from 'firebase/database'
import { GameState, SongItem } from './game-logic'

async function fetchLyricsViaApi(roomCode: string, song: SongItem): Promise<string | null> {
    try {
        const cacheRef = ref(db, `rooms/${roomCode}/lyrics_cache/${song.id}`)
        const snap = await get(cacheRef)
        if (snap.exists()) {
            return snap.val() as string
        }

        const res = await fetch(`/api/lyrics?artist=${encodeURIComponent(song.artist_name)}&title=${encodeURIComponent(song.track_name)}`)
        const data = await res.json()
        const lyrics = data.lyrics || null

        if (lyrics) {
            await set(cacheRef, lyrics)
        }

        return lyrics
    } catch (e) {
        console.error('[SuddenDeath] Lyrics fetch error', e)
        return null
    }
}

async function resolvePreviewViaApi(song: SongItem): Promise<{ previewUrl: string, deezerId?: string } | null> {
    try {
        const res = await fetch('/api/resolve-tracks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tracks: [{ artist: song.artist_name, title: song.track_name }] })
        })
        const data = await res.json()
        const match = data?.tracks?.find((t: any) => t?.resolved && t?.deezer?.preview_url)
        if (!match?.deezer?.preview_url) return null
        const previewUrl = match.deezer.preview_url.replace(/^http:\/\//i, 'https://').trim()
        return { previewUrl, deezerId: match.deezer.id }
    } catch (e) {
        console.error('[SuddenDeath] Preview resolve error', e)
        return null
    }
}

async function pickSongsWithLyrics(
    roomCode: string,
    candidates: SongItem[],
    targetCount: number
): Promise<SongItem[]> {
    const selected: SongItem[] = []
    const seen = new Set<string>()

    for (const song of candidates) {
        if (seen.has(song.id)) continue
        seen.add(song.id)

        const lyrics = await fetchLyricsViaApi(roomCode, song)
        if (lyrics) {
            selected.push(song)
        }

        if (selected.length >= targetCount) break
    }

    return selected
}

/**
 * Helper to safely update Firebase by removing undefined values
 */
async function safeUpdate(ref: any, data: Record<string, any>) {
    const clean = JSON.parse(JSON.stringify(data)) // Removes undefineds
    try {
        await update(ref, clean)
    } catch (e: any) {
        console.error('[SuddenDeath] safeUpdate failed:', e.message, clean)
        throw e
    }
}

/**
 * Initiate sudden death mode when players are tied
 */
export async function initiateSuddenDeath(
    roomCode: string,
    tiedPlayerIds: string[],
    currentGameState: GameState,
    allPlayers: any[],
    resolvedTieGroups: string[] = []
) {
    // 1. Collect all songs from tied players
    const roomRef = ref(db, `rooms/${roomCode}`)
    const snapshot = await get(roomRef)

    if (!snapshot.exists()) {
        throw new Error('Room not found')
    }

    const roomData = snapshot.val()
    const allSongs = Object.values(roomData.songs || {}) as SongItem[]

    // 2. Exclude songs already used in main game
    const usedSongIds = new Set(currentGameState.playlist.map(s => s.id))

    // Filter available songs by Owner First
    const tiedPlayerSongs = allSongs.filter(song =>
        tiedPlayerIds.includes(song.picked_by_user_id) && !usedSongIds.has(song.id)
    )

    // Also get ALL other available songs (fallback pool)
    const otherAvailableSongs = allSongs.filter(song =>
        !tiedPlayerIds.includes(song.picked_by_user_id) && !usedSongIds.has(song.id)
    )

    // 3. Select 2 songs per player for first sudden death batch
    // Keep a minimum chunk size of 5 to reduce frequent fetches.
    const baseCount = Math.max(2, tiedPlayerIds.length * 2)
    const chunkSize = 5
    const initialCount = Math.max(baseCount, chunkSize)

    // Try to fill with tied players first
    let suddenDeathPlaylist = selectSuddenDeathSongs(tiedPlayerSongs, tiedPlayerIds, initialCount)

    // If not enough, fill from fallback
    if (suddenDeathPlaylist.length < initialCount) {
        const needed = initialCount - suddenDeathPlaylist.length
        console.log(`[SuddenDeath] Not enough songs from duelists (got ${suddenDeathPlaylist.length}). Fetching ${needed} from pool.`)

        // Shuffle fallback pool
        const pool = otherAvailableSongs.sort(() => 0.5 - Math.random())
        const extras = pool.slice(0, needed)
        suddenDeathPlaylist = [...suddenDeathPlaylist, ...extras]
    }

    // NOTE: Lyrics validation happens during VS screen prefetch to avoid blocking the transition.

    console.log(`[SuddenDeath] Initiating with ${tiedPlayerIds.length} players, ${suddenDeathPlaylist.length} songs (requested ${initialCount})`)

    // 4. Update game state & Secrets
    // We must split the new songs into SECRETS (for DB) and MASKED (for Client)
    const updates: Record<string, any> = {
        [`rooms/${roomCode}/game_state/is_sudden_death`]: true,
        [`rooms/${roomCode}/game_state/dueling_player_ids`]: tiedPlayerIds,
        [`rooms/${roomCode}/game_state/sudden_death_round_count`]: 0,
        [`rooms/${roomCode}/game_state/sudden_death_start_index`]: currentGameState.playlist.length,
        [`rooms/${roomCode}/game_state/phase`]: 'vs_screen', // Show VS screen first
        [`rooms/${roomCode}/game_state/resolved_tie_groups`]: resolvedTieGroups || []
    }

    const startIndex = currentGameState.playlist.length
    const maskedNewSongs: any[] = []

    suddenDeathPlaylist.forEach((song, i) => {
        const absIndex = startIndex + i

        // 1. Write Secret
        updates[`room_secrets/${roomCode}/${absIndex}`] = song

        // 2. Prepare Masked for Playlist
        maskedNewSongs.push({
            id: song.id,
            picked_by_user_id: song.picked_by_user_id,
            preview_url: song.preview_url,
            artist_name: '???',
            track_name: '???',
            cover_url: '',
            spotify_uri: '' // Masked
        })
    })

    // Append MASKED songs to public playlist
    // Note: We can't use array push in Firebase update easily if we want to be atomic with other keys 
    // without reading/writing the whole object OR using numeric keys.
    // 'game_state/playlist' is an array.
    // We can update specific indices: "game_state/playlist/10": {...}
    maskedNewSongs.forEach((item, i) => {
        updates[`rooms/${roomCode}/game_state/playlist/${startIndex + i}`] = item
    })

    // Reset submissions for all players before sudden death starts
    allPlayers.forEach(p => {
        updates[`rooms/${roomCode}/players/${p.id}/has_submitted`] = false
        updates[`rooms/${roomCode}/players/${p.id}/last_guess`] = { artist: '', title: '' }
        updates[`rooms/${roomCode}/players/${p.id}/submitted_at`] = null
        updates[`rooms/${roomCode}/players/${p.id}/last_round_points`] = 0
        updates[`rooms/${roomCode}/players/${p.id}/last_round_correct_title`] = false
        updates[`rooms/${roomCode}/players/${p.id}/last_round_correct_artist`] = false
    })

    await safeUpdate(ref(db), updates)

    // 5. After 3 seconds (MINIMUM), start sudden death round
    // We do lyrics fetching here if needed
    setTimeout(async () => {
        // CHECK LYRICS (Client-Side Fetch via API)
        if (roomData.settings && roomData.settings.mode === 'lyrics_only') {
            console.log('[SuddenDeath] Checking lyrics for new playlist...')

            // Prefetch the first chunk to avoid repeated fetches each round.
            // Subsequent chunks are handled during reveal.
            const prefetchCount = Math.min(5, suddenDeathPlaylist.length)
            const prefetchSongs = suddenDeathPlaylist.slice(0, prefetchCount)
            const replacementUpdates: Record<string, any> = {}

            const maskedEntry = (song: SongItem) => ({
                id: song.id,
                picked_by_user_id: song.picked_by_user_id,
                preview_url: song.preview_url,
                artist_name: '???',
                track_name: '???',
                cover_url: '',
                spotify_uri: '' // Masked
            })

            const pickedIds = new Set(suddenDeathPlaylist.map(s => s.id))
            const remainingPool = [
                ...tiedPlayerSongs.filter(s => !pickedIds.has(s.id)),
                ...otherAvailableSongs.filter(s => !pickedIds.has(s.id))
            ].sort(() => 0.5 - Math.random())

            const pickReplacement = async (): Promise<{ song: SongItem, lyrics: string } | null> => {
                while (remainingPool.length > 0) {
                    const candidate = remainingPool.shift()!
                    const l = await fetchLyricsViaApi(roomCode, candidate)
                    if (l) {
                        return { song: candidate, lyrics: l }
                    }
                }
                return null
            }

            for (let i = 0; i < prefetchSongs.length; i++) {
                let song = prefetchSongs[i]
                let lyrics = await fetchLyricsViaApi(roomCode, song)
                const absIndex = startIndex + i

                if (!lyrics) {
                    console.warn(`[SuddenDeath] Lyrics failed for ${song.track_name}`)
                    const replacement = await pickReplacement()
                    if (replacement) {
                        song = replacement.song
                        lyrics = replacement.lyrics
                        suddenDeathPlaylist[i] = song
                        replacementUpdates[`room_secrets/${roomCode}/${absIndex}`] = song
                        replacementUpdates[`rooms/${roomCode}/game_state/playlist/${absIndex}`] = maskedEntry(song)
                        replacementUpdates[`rooms/${roomCode}/lyrics_cache/${song.id}`] = lyrics
                    } else {
                        continue
                    }
                }

                // Ensure preview is available for playback
                const hasPreview = typeof song.preview_url === 'string' && song.preview_url.trim().startsWith('http')
                if (!hasPreview) {
                    const resolved = await resolvePreviewViaApi(song)
                    if (resolved) {
                        const previewUrl = resolved.previewUrl
                        song.preview_url = previewUrl
                        replacementUpdates[`rooms/${roomCode}/songs/${song.id}/preview_url`] = previewUrl
                        replacementUpdates[`room_secrets/${roomCode}/${absIndex}/preview_url`] = previewUrl
                        replacementUpdates[`rooms/${roomCode}/game_state/playlist/${absIndex}/preview_url`] = previewUrl
                        if (resolved.deezerId) {
                            song.spotify_uri = resolved.deezerId
                            replacementUpdates[`rooms/${roomCode}/songs/${song.id}/spotify_uri`] = resolved.deezerId
                            replacementUpdates[`room_secrets/${roomCode}/${absIndex}/spotify_uri`] = resolved.deezerId
                        }
                    }
                }
            }

            if (Object.keys(replacementUpdates).length > 0) {
                await safeUpdate(ref(db), replacementUpdates)
            }
        }

        await safeUpdate(ref(db, `rooms/${roomCode}/game_state`), {
            phase: 'playing',
            current_round_index: currentGameState.playlist.length, // First sudden death song
            round_start_time: serverTimestamp() as any,
            force_reveal_at: null
        })
    }, 3000)
}

/**
 * Select sudden death songs with round-robin distribution from tied players
 */
function selectSuddenDeathSongs(
    availableSongs: SongItem[],
    playerIds: string[],
    count: number
): SongItem[] {
    // Group by user
    const songsByUser: Record<string, SongItem[]> = {}
    availableSongs.forEach(song => {
        if (!songsByUser[song.picked_by_user_id]) {
            songsByUser[song.picked_by_user_id] = []
        }
        songsByUser[song.picked_by_user_id].push(song)
    })

    // Round-robin selection
    const selected: SongItem[] = []
    let idx = 0
    const maxIterations = count * playerIds.length + 100 // Safety limit

    while (selected.length < count && idx < maxIterations) {
        const playerId = playerIds[idx % playerIds.length]
        const userSongs = songsByUser[playerId]

        if (userSongs && userSongs.length > 0) {
            selected.push(userSongs.shift()!)
        }

        // Check if all players exhausted
        const hasAnySongs = Object.values(songsByUser).some(arr => arr.length > 0)
        if (!hasAnySongs) break

        idx++
    }

    // Shuffle final selection
    return selected.sort(() => 0.5 - Math.random())
}

/**
 * Fetch more sudden death songs when the pool is running low
 */
export async function fetchMoreSuddenDeathSongs(
    roomCode: string,
    currentGameState: GameState
): Promise<boolean> {
    const tiedPlayerIds = currentGameState.dueling_player_ids || []

    if (tiedPlayerIds.length === 0) {
        console.warn('[SuddenDeath] No dueling players defined')
        return false
    }

    // Get all available songs from tied players
    const roomRef = ref(db, `rooms/${roomCode}`)
    const snapshot = await get(roomRef)

    if (!snapshot.exists()) return false

    const roomData = snapshot.val()
    const allSongs = Object.values(roomData.songs || {}) as SongItem[]

    const usedSongIds = new Set(currentGameState.playlist.map(s => s.id))

    // 1. Try tied players first
    const tiedPlayerSongs = allSongs.filter(song =>
        tiedPlayerIds.includes(song.picked_by_user_id) &&
        !usedSongIds.has(song.id)
    )

    // 2. Fallback pool
    const otherAvailableSongs = allSongs.filter(song =>
        !tiedPlayerIds.includes(song.picked_by_user_id) &&
        !usedSongIds.has(song.id)
    )

    // Add a chunk of songs at a time (minimum 5) to avoid frequent fetches
    const moreCount = Math.max(5, tiedPlayerIds.length * 2)
    let newSongs = selectSuddenDeathSongs(tiedPlayerSongs, tiedPlayerIds, moreCount)

    if (newSongs.length < moreCount) {
        const needed = moreCount - newSongs.length
        console.log(`[SuddenDeath] FetchMore: Not enough from duelists. Need ${needed} more from pool.`)

        const pool = otherAvailableSongs.sort(() => 0.5 - Math.random())
        const extras = pool.slice(0, needed)
        newSongs = [...newSongs, ...extras]
    }

    if (roomData.settings && roomData.settings.mode === 'lyrics_only') {
        const pickedIds = new Set(newSongs.map(s => s.id))
        const remainingPool = [
            ...tiedPlayerSongs.filter(s => !pickedIds.has(s.id)),
            ...otherAvailableSongs.filter(s => !pickedIds.has(s.id))
        ].sort(() => 0.5 - Math.random())

        const candidates = [...newSongs, ...remainingPool]
        const withLyrics = await pickSongsWithLyrics(roomCode, candidates, moreCount)

        if (withLyrics.length < moreCount) {
            console.warn(`[SuddenDeath] FetchMore: Only ${withLyrics.length}/${moreCount} songs have lyrics.`)
        }

        newSongs = withLyrics
    }

    if (newSongs.length === 0) {
        console.warn('[SuddenDeath] ABSOLUTELY NO SONGS LEFT IN ENTIRE ROOM!')
        return false
    }

    console.log(`[SuddenDeath] Fetching ${newSongs.length} more songs`)

    const updates: Record<string, any> = {}
    const startIndex = currentGameState.playlist.length
    const maskedNewSongs: any[] = []

    newSongs.forEach((song, i) => {
        const absIndex = startIndex + i

        // 1. Write Secret
        updates[`room_secrets/${roomCode}/${absIndex}`] = song

        // 2. Prepare Masked
        maskedNewSongs.push({
            id: song.id,
            picked_by_user_id: song.picked_by_user_id,
            preview_url: song.preview_url,
            artist_name: '???',
            track_name: '???',
            cover_url: '',
            spotify_uri: '' // Masked
        })

        // 3. Update public playlist index
        updates[`rooms/${roomCode}/game_state/playlist/${absIndex}`] = maskedNewSongs[i]
    })

    updates[`rooms/${roomCode}/game_state/sudden_death_round_count`] = (currentGameState.sudden_death_round_count || 0) + newSongs.length

    await safeUpdate(ref(db), updates)

    return true
}

/**
 * End sudden death and finish the game
 */
export async function endSuddenDeath(roomCode: string, players: any[]) {
    // Find winner by highest score
    // Find winner by highest SUDDEN DEATH score
    const sorted = [...players].sort((a, b) => (b.sudden_death_score || 0) - (a.sudden_death_score || 0))
    const topScore = sorted[0]?.sudden_death_score ?? 0
    const drawPlayers = sorted.filter(p => (p.sudden_death_score || 0) === topScore)

    const isDraw = drawPlayers.length > 1

    if (isDraw) {
        console.log('[SuddenDeath] Still tied after all songs - declaring draw')
    } else {
        console.log(`[SuddenDeath] Winner: ${sorted[0].username} with ${sorted[0].score} points`)
    }

    // Use safeUpdate here too
    await safeUpdate(ref(db, `rooms/${roomCode}`), {
        status: 'finished',
        'game_state/phase': 'finished',
        'game_state/is_sudden_death': false,
        'game_state/draw': isDraw,
        'game_state/draw_player_ids': isDraw ? drawPlayers.map(p => p.id) : null
    })
}
