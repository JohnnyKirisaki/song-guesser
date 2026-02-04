import { supabase } from './supabase'

export type GameState = {
    // Current song/round info
    current_round_index: number
    playlist: SongItem[]

    // Phase
    phase: 'starting' | 'playing' | 'reveal' | 'finished' | 'vs_screen'
    round_start_time: string | null // ISO string for timer sync

    // Sudden Death
    is_sudden_death: boolean
    dueling_player_ids?: string[] // IDs of players currently in a tie-breaker
    sudden_death_round_count?: number
    answers_revealed: boolean
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

export async function initializeGame(roomCode: string, settings: any) {
    // 1. Fetch all songs associated with the room
    const { data: allSongs, error: songsError } = await supabase
        .from('room_songs')
        .select('*')
        .eq('room_code', roomCode)

    if (songsError) {
        console.error('[GameLogic] Songs Error:', songsError)
        throw new Error(`DB Error fetching songs: ${songsError.message}`)
    }

    if (!allSongs || allSongs.length === 0) {
        throw new Error('No songs available to start game. Please import a playlist.')
    }

    // 2. Fetch players to know who is in game
    const { data: players, error: playersError } = await supabase
        .from('room_players')
        .select('user_id')
        .eq('room_code', roomCode)

    if (playersError) {
        console.error('[GameLogic] Players Error:', playersError)
        throw new Error(`DB Error fetching players: ${playersError.message}`)
    }

    if (!players || players.length === 0) {
        throw new Error('No players found in room.')
    }

    // 3. Global Duplicate Filtering & Selection
    // We want unique songs across the entire pool, not just per user.
    // Preference: If same song added by multiple users, keep one (maybe random picker?)
    // But we need to ensure fair "pick" distribution if possible.

    // Shuffle all songs first to randomize which duplicate is kept
    const shuffledRaw = allSongs.sort(() => 0.5 - Math.random())
    const uniqueSongs: SongItem[] = []
    const seenKeys = new Set<string>()

    shuffledRaw.forEach(song => {
        const key = `${song.artist_name.toLowerCase().trim()}|${song.track_name.toLowerCase().trim()}`
        if (!seenKeys.has(key)) {
            seenKeys.add(key)
            uniqueSongs.push(song)
        }
    })

    let totalRounds = settings.rounds || 10

    // Check 36: Pool Size Enforcement
    // If not enough unique songs, reduce rounds
    if (uniqueSongs.length < totalRounds) {
        console.warn(`[GameLogic] Not enough unique songs (${uniqueSongs.length}) for ${totalRounds} rounds. Reducing rounds.`)
        totalRounds = uniqueSongs.length
    }

    // 4. Select Songs for Playlist
    // We already shuffled, so just take the first N unique songs
    // (This is simple and ensures variety. Fairness of "who picked what" is secondary to uniqueness here)
    // 4. Select Songs for Playlist (Fair Pick / Round Robin)
    // Group songs by user
    const songsByUser: Record<string, SongItem[]> = {}
    uniqueSongs.forEach(song => {
        if (!songsByUser[song.picked_by_user_id]) songsByUser[song.picked_by_user_id] = []
        songsByUser[song.picked_by_user_id].push(song)
    })

    const playlist: SongItem[] = []
    // Shuffle user order to ensure "random fill" for non-divisible rounds
    const userIds = Object.keys(songsByUser).sort(() => 0.5 - Math.random())

    // Safety check: if no users (shouldn't happen due to players check), just take uniqueSongs
    if (userIds.length === 0) {
        playlist.push(...uniqueSongs.slice(0, totalRounds))
    } else {
        let loopIndex = 0
        while (playlist.length < totalRounds && uniqueSongs.length > 0) {
            // Check if we exhausted all available unique songs
            if (playlist.length >= uniqueSongs.length) break

            const currentUser = userIds[loopIndex % userIds.length]
            const userSongs = songsByUser[currentUser]

            if (userSongs && userSongs.length > 0) {
                // Pick one and remove
                const picked = userSongs.pop()! // Remove from user's stack
                playlist.push(picked)
            }

            loopIndex++

            // Break if we've looped too many times without adding (safety)
            if (loopIndex > totalRounds * userIds.length + 100) break
        }
    }

    // 5. Final Shuffle of the playlist to mix players' picks
    const finalPlaylist = playlist.sort(() => 0.5 - Math.random())

    // 6. Create Initial Game State
    const initialGameState: GameState = {
        playlist: finalPlaylist,
        current_round_index: 0,
        round_start_time: null, // Will be set when "Starting" animation finishes
        phase: 'starting',
        answers_revealed: false,
        is_sudden_death: false // New field
    }

    // 7. Update Room
    // Update settings with actual rounds if changed
    const updatedSettings = { ...settings, rounds: totalRounds }

    const { error: updateError } = await supabase
        .from('rooms')
        .update({
            game_state: initialGameState as any,
            status: 'playing',
            settings: updatedSettings
        })
        .eq('code', roomCode)

    if (updateError) throw updateError
}
