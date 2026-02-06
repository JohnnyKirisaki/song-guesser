import { db } from '@/lib/firebase'
import { ref, update, serverTimestamp } from 'firebase/database'
import { GameState } from './game-logic'
import { initiateSuddenDeath } from './sudden-death'

export interface Player {
    id: string
    username: string
    score: number
    has_submitted: boolean
    submitted_at?: number | any
    last_guess?: any
    last_round_points?: number
    last_round_correct_title?: boolean
    last_round_correct_artist?: boolean
    avatar_url?: string
    sudden_death_score?: number
}

// Helper to find tie groups
function getFirstTieGroup(list: Player[], resolvedGroups: Set<string> = new Set()): string[] {
    const groups: Record<number, Player[]> = {}
    list.forEach(p => {
        const score = p.score || 0
        if (!groups[score]) groups[score] = []
        groups[score].push(p)
    })

    const scores = Object.keys(groups).map(Number).sort((a, b) => a - b)
    for (const score of scores) {
        if (groups[score].length > 1) {
            const groupIds = groups[score].map(p => p.id).sort()
            const groupKey = groupIds.join('|')
            if (resolvedGroups.has(groupKey)) continue
            return groupIds
        }
    }
    return []
}

export async function processNextRound(
    roomCode: string,
    gameState: GameState,
    players: Player[],
    settings: { rounds?: number, time?: number, mode?: string }
) {
    const currentIsSuddenDeath = gameState.is_sudden_death

    // SUDDEN DEATH: Check if we need more songs
    if (currentIsSuddenDeath) {
        const duelingIds = gameState.dueling_player_ids || []
        const duelingPlayers = players.filter(p => duelingIds.includes(p.id))

        if (duelingPlayers.length >= 2) {
            // Sort by SUDDEN DEATH SCORE
            const sorted = [...duelingPlayers].sort((a, b) => (b.sudden_death_score || 0) - (a.sudden_death_score || 0))
            const leaderScore = sorted[0]?.sudden_death_score || 0
            const secondScore = sorted[1]?.sudden_death_score || 0
            const restScores = sorted.slice(1).map(p => p.sudden_death_score || 0)
            const restHasTie = restScores.length > 1 && new Set(restScores).size !== restScores.length

            // Win-by-2 rule
            if (leaderScore >= secondScore + 2 && !restHasTie) {
                const resolvedGroups = new Set(gameState.resolved_tie_groups || [])
                const finishedGroupKey = [...duelingIds].sort().join('|')
                if (finishedGroupKey) resolvedGroups.add(finishedGroupKey)

                const nextTieGroup = getFirstTieGroup(players, resolvedGroups)

                if (nextTieGroup.length > 1) {
                    // Another tie exists! Start next duel
                    await initiateSuddenDeath(roomCode, nextTieGroup, gameState, players, Array.from(resolvedGroups))
                    return
                } else {
                    // No more ties -> Game Over. Clear SD flag.
                    await update(ref(db, `rooms/${roomCode}`), {
                        status: 'finished',
                        'game_state/phase': 'end',
                        'game_state/end_time': Date.now(),
                        'game_state/is_sudden_death': false,
                        'game_state/resolved_tie_groups': Array.from(resolvedGroups)
                    })
                    return
                }
            } else {
                // Duel continues
            }
        }
    }

    // Normal End of Game Check
    const MAX_ROUNDS = settings?.rounds || 5
    // Ensure we handle the "Index is 0-based" correctly. Round 1 is Index 0. 
    // If rounds=5, Max Index is 4. Next Round would be 5.
    // So if current_round_index >= 4 (i.e. we just finished round 5), we end.
    if (gameState.current_round_index >= MAX_ROUNDS - 1 && !currentIsSuddenDeath) {
        // Check for ties
        const resolvedGroups = new Set(gameState.resolved_tie_groups || [])
        const tieGroup = getFirstTieGroup(players, resolvedGroups)
        if (tieGroup.length > 1) {
            await initiateSuddenDeath(roomCode, tieGroup, gameState, players, Array.from(resolvedGroups))
        } else {
            await update(ref(db, `rooms/${roomCode}`), {
                status: 'finished',
                'game_state/phase': 'end',
                'game_state/end_time': Date.now()
            })
        }
    } else {
        // Next Round (Normal or Sudden Death continues)
        // If we are in SD and didn't trigger game over, we default here to next song
        const nextRound = gameState.current_round_index + 1

        await update(ref(db, `rooms/${roomCode}`), {
            'game_state/phase': 'playing',
            'game_state/current_round_index': nextRound,
            // Use server time so all clients share the same reference.
            'game_state/round_start_time': serverTimestamp() as any,
            'game_state/force_reveal_at': null, // Clear any force reveal
            // Reset submissions
            ...Object.fromEntries(players.map(p => [`players/${p.id}/has_submitted`, false])),
            ...Object.fromEntries(players.map(p => [`players/${p.id}/last_guess`, null])),
            ...Object.fromEntries(players.map(p => [`players/${p.id}/last_round_score`, 0])),
            ...Object.fromEntries(players.map(p => [`players/${p.id}/last_round_correct_artist`, false])),
            ...Object.fromEntries(players.map(p => [`players/${p.id}/last_round_correct_title`, false]))
        })

        // Sudden death top-ups are handled during reveal to keep
        // "Next Round" fast and move fetch work off the click path.
    }
}
