import { db } from '@/lib/firebase'
import { ref, get, update, serverTimestamp } from 'firebase/database'
import { shuffleArray } from './game-utils'
import { fetchLyrics } from '@/lib/lyrics'

export type GameState = {
    // Current song/round info
    current_round_index: number
    playlist: SongItem[]

    // Phase
    phase: 'starting' | 'playing' | 'reveal' | 'finished' | 'vs_screen'
    round_start_time: string | number | null // ISO string or server timestamp (ms)
    reveal_start_time?: string | number | null
    force_reveal_at?: string | number | null

    // Sudden Death
    is_sudden_death: boolean
    dueling_player_ids?: string[] // IDs of players currently in a tie-breaker
    sudden_death_round_count?: number
    sudden_death_start_index?: number
    answers_revealed: boolean

    // Draw state (when sudden death runs out of songs)
    draw?: boolean
    draw_player_ids?: string[]

    // Track resolved tie groups across sudden death chains
    resolved_tie_groups?: string[]

    // Current Round Answer (Revealed by Host via Server)
    current_round_answer?: {
        artist: string
        title: string
        cover_url: string
    }
}

export type SongItem = {
    id: string
    spotify_uri: string
    artist_name: string
    track_name: string
    cover_url: string
    preview_url: string | null
    picked_by_user_id: string
}

export type MaskedSongItem = Omit<SongItem, 'artist_name' | 'track_name' | 'cover_url'> & {
    artist_name?: string // Optional/Masked
    track_name?: string  // Optional/Masked
    cover_url?: string   // Optional/Masked
}

// Separate logic side (generation) from effect side (db write)
export async function prepareGamePayload(
    roomCode: string,
    settings: any,
    onProgress?: (percent: number) => Promise<void>
) {
    // 1. Fetch Room Data (Songs + Players)
    if (onProgress) await onProgress(5) // Started
    const roomRef = ref(db, `rooms/${roomCode}`)
    const snapshot = await get(roomRef)

    if (!snapshot.exists()) {
        throw new Error('Room does not exist')
    }

    const roomData = snapshot.val()
    const allSongs = Object.values(roomData.songs || {}) as SongItem[]
    const players = Object.values(roomData.players || {}) as any[]

    if (allSongs.length === 0) {
        throw new Error('No songs available. Import a playlist first!')
    }

    if (players.length === 0) {
        throw new Error('No players found in room.')
    }

    // 2. Global Duplicate Filtering & Selection
    // Shuffle all songs first to randomize which duplicate is kept
    const shuffledRaw = shuffleArray(allSongs)
    const uniqueSongs: SongItem[] = []
    const seenKeys = new Set<string>()

    shuffledRaw.forEach(song => {
        const key = `${song.artist_name.toLowerCase().trim()}|${song.track_name.toLowerCase().trim()}`
        if (!seenKeys.has(key)) {
            seenKeys.add(key)
            uniqueSongs.push(song)
        }
    })

    const requestedRounds = Math.min(settings.rounds || 10, 50) // Cap at 50 max (matches UI)

    // Enforce max time per round (5-30s)
    const safeTime = Math.min(Math.max(settings.time || 15, 5), 30)

    // Ensure enough unique songs for the requested rounds
    if (uniqueSongs.length < requestedRounds) {
        throw new Error(`Not enough unique songs (${uniqueSongs.length}) for ${requestedRounds} rounds.`)
    }

    // 3. Select Songs for Playlist (Fair Ratio per Player)
    const songsByUser: Record<string, SongItem[]> = {}
    uniqueSongs.forEach(song => {
        if (!songsByUser[song.picked_by_user_id]) songsByUser[song.picked_by_user_id] = []
        songsByUser[song.picked_by_user_id].push(song)
    })

    // Shuffle each user's pool for fairness
    Object.keys(songsByUser).forEach(uid => {
        songsByUser[uid] = shuffleArray(songsByUser[uid])
    })

    const playlist: SongItem[] = []
    const userIds = shuffleArray(Object.keys(songsByUser))

    if (userIds.length === 0) {
        playlist.push(...uniqueSongs.slice(0, requestedRounds))
    } else {
        // Base allocation
        const base = Math.floor(requestedRounds / userIds.length)
        const remainder = requestedRounds % userIds.length
        const extraUsers = new Set(shuffleArray(userIds).slice(0, remainder))

        const desiredCounts: Record<string, number> = {}
        userIds.forEach(uid => {
            desiredCounts[uid] = base + (extraUsers.has(uid) ? 1 : 0)
        })

        // Minimum pool size enforcement (2/3 * min source size * players)
        const minSongsPerUser = Math.min(...userIds.map(uid => songsByUser[uid]?.length || 0))
        if (minSongsPerUser > 0) {
            const maxRoundsByPool = Math.floor((2 / 3) * minSongsPerUser * userIds.length)
            if (maxRoundsByPool > 0 && requestedRounds > maxRoundsByPool) {
                throw new Error(`Minimum pool size rule failed. Max rounds allowed: ${maxRoundsByPool}.`)
            }
        }

        // First pass: pull desired counts per user
        userIds.forEach(uid => {
            const pool = songsByUser[uid] || []
            const take = Math.min(pool.length, desiredCounts[uid])
            playlist.push(...pool.splice(0, take))
        })

        // Fill any remaining slots randomly from remaining pools
        const remainingPool = shuffleArray(Object.values(songsByUser).flat())
        const remainingSlots = requestedRounds - playlist.length
        if (remainingSlots > 0) {
            playlist.push(...remainingPool.slice(0, remainingSlots))
        }
    }

    // 4. Validate Lyrics (Server-Side) ONLY for lyrics_only mode
    // We do this BEFORE Final Shuffle to ensure we have X valid songs.
    const validPlaylist: SongItem[] = []
    const lyricsCache: Record<string, string> = {}

    if (settings.mode === 'lyrics_only') {
        const needed = requestedRounds
        const pool = uniqueSongs.filter(s => !playlist.find(p => p.id === s.id)) // Remaining pool

        // Combine initial playlist + pool to search through
        // We start with the playlist we logically selected
        // If a song fails, we try to grab one from pool

        let validatedCount = 0
        const candidates = [...playlist, ...pool] // Checking everything

        // We want to preserve the "fairness" logic if possible, 
        // but correctness (valid lyrics) takes precedence.

        for (const song of candidates) {
            if (validatedCount >= needed) break

            // Skip if we already have it (duplicates in candidates array from [...playlist, ...pool] if pool logic was different?)
            // Actually `pool` above was filtered to NOT be in `playlist`.
            // So candidates = [original_selection, reserve_pool]

            // Progress Update: 10% base + up to 80% based on validated count
            if (onProgress) {
                const progress = 10 + Math.floor((validatedCount / needed) * 80)
                await onProgress(Math.min(95, progress))
            }

            // Check Lyrics
            // Using blocking 'await' as requested ("hang a seconds until new song lyrics are fetched")
            const lyrics = await fetchLyrics(song.artist_name, song.track_name)

            if (lyrics) {
                validPlaylist.push(song)
                lyricsCache[song.id] = lyrics
                validatedCount++
            } else {
                // Song failed, skip it
                // console.log(`Skipping ${song.track_name} due to missing lyrics`)
            }
        }

        if (validPlaylist.length < needed) {
            throw new Error(`Not enough songs with valid lyrics! Found ${validPlaylist.length}, need ${needed}.`)
        }

    } else {
        validPlaylist.push(...playlist)
    }

    if (onProgress) await onProgress(100) // Finalizing

    // 5. Final Shuffle
    const finalPlaylist = shuffleArray(validPlaylist)

    // 6. Create Initial Game State (Auto-start first round)
    const initialGameState: GameState = {
        playlist: finalPlaylist,
        current_round_index: 0,
        round_start_time: serverTimestamp() as any, // Use server time for sync
        phase: 'playing', // Auto-start instead of waiting in 'starting'
        answers_revealed: false,
        is_sudden_death: false,
        draw: false,
        draw_player_ids: null as any,
        resolved_tie_groups: []
    }

    // 6. Return Payload (Don't write yet)
    const updatedSettings = { ...settings, rounds: requestedRounds, time: safeTime }

    const updates: Record<string, any> = {}
    updates[`rooms/${roomCode}/game_state`] = initialGameState
    updates[`rooms/${roomCode}/status`] = 'playing'
    updates[`rooms/${roomCode}/settings`] = updatedSettings

    // Write initial lyrics cache (if any)
    if (Object.keys(lyricsCache).length > 0) {
        Object.entries(lyricsCache).forEach(([sid, txt]) => {
            updates[`rooms/${roomCode}/lyrics_cache/${sid}`] = txt
        })
    }

    return { updates, playlist: finalPlaylist }
}

export async function initializeGame(roomCode: string, settings: any) {
    const { updates } = await prepareGamePayload(roomCode, settings)
    await update(ref(db), updates)
}
