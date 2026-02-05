import { db } from '@/lib/firebase'
import { ref, get, update, serverTimestamp } from 'firebase/database'
import { GameState, SongItem } from './game-logic'

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

    const tiedPlayerSongs = allSongs.filter(song =>
        tiedPlayerIds.includes(song.picked_by_user_id)
    )

    // 2. Exclude songs already used in main game
    const usedSongIds = new Set(currentGameState.playlist.map(s => s.id))
    const availableSongs = tiedPlayerSongs.filter(s => !usedSongIds.has(s.id))

    // 3. Select 2 songs per player for first sudden death batch
    const initialCount = Math.max(2, tiedPlayerIds.length * 2)
    const suddenDeathPlaylist = selectSuddenDeathSongs(availableSongs, tiedPlayerIds, initialCount)

    console.log(`[SuddenDeath] Initiating with ${tiedPlayerIds.length} players, ${suddenDeathPlaylist.length} initial songs`)

    // 4. Update game state
    const updates: Record<string, any> = {
        'game_state/is_sudden_death': true,
        'game_state/dueling_player_ids': tiedPlayerIds,
        'game_state/sudden_death_round_count': 0,
        'game_state/playlist': [...currentGameState.playlist, ...suddenDeathPlaylist],
        'game_state/phase': 'vs_screen', // Show VS screen first
        'game_state/resolved_tie_groups': resolvedTieGroups
    }

    // Reset submissions for all players before sudden death starts
    allPlayers.forEach(p => {
        updates[`players/${p.id}/has_submitted`] = false
        updates[`players/${p.id}/last_guess`] = { artist: '', title: '' }
        updates[`players/${p.id}/submitted_at`] = null
        updates[`players/${p.id}/last_round_points`] = 0
        updates[`players/${p.id}/last_round_correct_title`] = false
        updates[`players/${p.id}/last_round_correct_artist`] = false
    })

    await update(roomRef, updates)

    // 5. After 3 seconds, start sudden death round
    setTimeout(async () => {
        await update(ref(db, `rooms/${roomCode}/game_state`), {
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
    const availableSongs = allSongs.filter(song =>
        tiedPlayerIds.includes(song.picked_by_user_id) &&
        !usedSongIds.has(song.id)
    )

    if (availableSongs.length === 0) {
        console.warn('[SuddenDeath] No more songs available from tied players')
        return false
    }

    // Add 2 more songs per player
    const moreCount = Math.max(2, tiedPlayerIds.length * 2)
    const newSongs = selectSuddenDeathSongs(availableSongs, tiedPlayerIds, moreCount)

    console.log(`[SuddenDeath] Fetching ${newSongs.length} more songs`)

    await update(ref(db, `rooms/${roomCode}/game_state`), {
        playlist: [...currentGameState.playlist, ...newSongs],
        sudden_death_round_count: (currentGameState.sudden_death_round_count || 0) + newSongs.length
    })

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

    await update(ref(db, `rooms/${roomCode}`), {
        status: 'finished',
        'game_state/phase': 'finished',
        'game_state/is_sudden_death': false,
        'game_state/draw': isDraw,
        'game_state/draw_player_ids': isDraw ? drawPlayers.map(p => p.id) : null
    })
}
