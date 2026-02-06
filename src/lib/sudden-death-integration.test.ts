import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processNextRound, Player } from './game-round-manager'
import { GameState } from './game-logic'

// --- MOCKS ---
const mockUpdate = vi.fn()
const mockGet = vi.fn()
const mockRef = vi.fn()

// Mock Firebase
vi.mock('firebase/database', () => ({
    get: (ref: any) => mockGet(ref),
    update: (ref: any, data: any) => mockUpdate(ref, data),
    ref: (db: any, path: string) => mockRef(db, path),
    serverTimestamp: () => 1234567890
}))

vi.mock('@/lib/firebase', () => ({
    db: {}
}))

// Mock fetch for lyrics (used in sudden-death logic)
global.fetch = vi.fn(() => Promise.resolve({
    json: () => Promise.resolve({ lyrics: 'la la la' })
})) as any

// Spy on console to keep output clean
vi.spyOn(console, 'log').mockImplementation(() => { })
vi.spyOn(console, 'warn').mockImplementation(() => { })

describe('Full Game Flow: Ties -> Sudden Death -> Win', () => {

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('should play 5 rounds, enter sudden death, tie 3 times, then win', async () => {
        const ROOM_CODE = 'TEST_ROOM'
        const SETTINGS = { rounds: 5, time: 5, mode: 'lyrics_only' }

        // Players (2 Players)
        const players: Player[] = [
            { id: 'p1', username: 'Player1', score: 0, has_submitted: false, sudden_death_score: 0 },
            { id: 'p2', username: 'Player2', score: 0, has_submitted: false, sudden_death_score: 0 }
        ]

        // Mock Get for room data (needed for sudden death song pool)
        mockGet.mockResolvedValue({
            exists: () => true,
            val: () => ({
                songs: Array(20).fill(null).reduce((acc, _, i) => {
                    acc[`s${i}`] = {
                        id: `s${i}`,
                        artist_name: `Artist ${i}`,
                        track_name: `Title ${i}`,
                        picked_by_user_id: i % 2 === 0 ? 'p1' : 'p2',
                        preview_url: 'http://foo.com/bar.mp3'
                    }
                    return acc
                }, {})
            })
        })

        // Initial Game State (Round 0)
        let gameState: GameState = {
            current_round_index: 0,
            playlist: Array(10).fill({ id: 's', artist_name: 'A', track_name: 'T' }), // enough songs
            phase: 'reveal', // We simulate calling next round FROM reveal
            round_start_time: 1000,
            answers_revealed: true,
            is_sudden_death: false,
            resolved_tie_groups: []
        }

        // --- ROUNDS 1-5 (INDICES 0-4) ---
        // Player inputs are EMPTY (score 0)
        // We simulate the sequence: Play -> Reveal -> Next Round

        for (let round = 0; round < 5; round++) {
            // console.log(`--- Round ${round + 1} (Idx ${round}) ---`)
            gameState.current_round_index = round
            gameState.phase = 'reveal'

            // Mock update to capture state changes
            mockUpdate.mockImplementation((ref, data) => {
                // Apply update to local state for next iteration
                // Check if updating entire game_state or partial
                if (data['game_state/phase']) {
                    gameState.phase = data['game_state/phase']
                }
                if (typeof data['game_state/current_round_index'] === 'number') {
                    gameState.current_round_index = data['game_state/current_round_index']
                }
                if (data['game_state/is_sudden_death']) {
                    gameState.is_sudden_death = data['game_state/is_sudden_death']
                }
                if (data['game_state/dueling_player_ids']) {
                    gameState.dueling_player_ids = data['game_state/dueling_player_ids']
                }
                if (data['game_state/sudden_death_round_count'] !== undefined) {
                    gameState.sudden_death_round_count = data['game_state/sudden_death_round_count']
                }
                if (data['status']) {
                    // Game Finished?
                }
            })

            // Run Logic
            await processNextRound(ROOM_CODE, gameState, players, SETTINGS)

            // Verification depends on round
            if (round < 4) {
                // Should move to next round (e.g. 0 -> 1)
                // Note: processNextRound actually increments the index in the update call
                // Our mock implementation above applies it.
                expect(gameState.phase).toBe('playing')
                expect(gameState.current_round_index).toBe(round + 1)
            } else {
                // Round 4 (5th round) Finished -> Should enter SUDDEN DEATH (initiateSuddenDeath)
                // initiateSuddenDeath sets phase -> vs_screen, is_sudden_death -> true

                // processNextRound calls initiateSuddenDeath internally if ties
                // We need to ensure initiateSuddenDeath is actually doing the update
                // Since `sudden-death.ts` imports `db` and uses `update`, and we mocked `update`, it should work.

                // Expect VS SCREEN first
                expect(gameState.phase).toBe('vs_screen')
                expect(gameState.is_sudden_death).toBe(true)
                expect(gameState.dueling_player_ids).toHaveLength(2)
            }
        }

        // --- SUDDEN DEATH (Rounds 6-8) ---
        // Indices 5, 6, 7
        // Players still empty answers -> Scores tied at 0

        // The playlist index continues incrementing.
        // Current index should be 5 (start of SD logic, first song of SD)
        // Note: initiateSuddenDeath sets index = playlist.length (which is 10 in our mock)
        // Wait, initiateSuddenDeath appends current playlist length as start index.
        // In our mock playlist, we had 10 songs. But game only used 5. 
        // Logic in initiate:: index = currentGameState.playlist.length
        // This is a mismatch in my mock setup vs real logic. 
        // Real logic: initSD fetches NEW songs and APPENDS them.

        // Let's adjust gameState playlist expectation or mock fetch.
        // But for this test, we can just assume playlist has enough songs.
        // The CRITICAL part is the Index. 
        // gameState.current_round_index was 5 (after loop).

        // Verify we are in SD
        expect(gameState.is_sudden_death).toBe(true)

        // Simulate 3 rounds of empty answers (Still TIED)
        for (let i = 0; i < 3; i++) {
            gameState.phase = 'reveal'

            // Scores are still 0-0 in SD
            await processNextRound(ROOM_CODE, gameState, players, SETTINGS)

            // Should continue SD
            expect(gameState.phase).toBe('playing')
            expect(gameState.is_sudden_death).toBe(true)
            // Index increments
        }

        // --- SUDDEN DEATH (Round 9) ---
        // ONE WINNER
        gameState.phase = 'reveal'

        // Update Player Scores to simulate a win
        players[0].sudden_death_score = 10
        players[1].sudden_death_score = 0
        // (Win by 2 rule met)

        // Mock update to catch 'finished' status
        let finished = false
        mockUpdate.mockImplementation((ref, data) => {
            if (data.status === 'finished') finished = true
        })

        await processNextRound(ROOM_CODE, gameState, players, SETTINGS)

        expect(finished).toBe(true)
    })
})
