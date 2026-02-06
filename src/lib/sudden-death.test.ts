import { describe, it, expect, vi, beforeEach } from 'vitest'
import { initiateSuddenDeath } from './sudden-death'

// Mock Firebase
const mockUpdate = vi.fn()
const mockGet = vi.fn()
const mockSet = vi.fn()
const mockRef = vi.fn()

vi.mock('firebase/database', () => ({
    get: (ref: any) => mockGet(ref),
    update: (ref: any, data: any) => mockUpdate(ref, data),
    set: (ref: any, data: any) => mockSet(ref, data),
    ref: (db: any, path: string) => mockRef(db, path),
    serverTimestamp: () => 'TIMESTAMP'
}))

vi.mock('@/lib/firebase', () => ({
    db: {}
}))

describe('initiateSuddenDeath', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('should sanitize undefined values from the update payload', async () => {
        // Setup Mocks
        mockGet.mockResolvedValue({
            exists: () => true,
            val: () => ({
                songs: {
                    'song1': { id: 'song1', picked_by_user_id: 'p1', artist_name: 'A', track_name: 'T' },
                    'song2': { id: 'song2', picked_by_user_id: 'p2', artist_name: 'B', track_name: 'T2' }
                },
                settings: { mode: 'normal' }
            })
        })

        // Create a GameState with a "poisoned" playlist item (undefined field)
        const currentGameState: any = {
            playlist: [
                { id: 'old1', artist_name: 'Old', track_name: 'Old', extra: undefined } // POISON
            ],
            dueling_player_ids: [],
            sudden_death_round_count: 0
        }

        const players = [{ id: 'p1', username: 'P1' }, { id: 'p2', username: 'P2' }]

        // Execute
        await initiateSuddenDeath('ROOM_CODE', ['p1', 'p2'], currentGameState, players)

        // Verify UPDATE was called
        expect(mockUpdate).toHaveBeenCalled()

        // Get the arguments of the first call to update (which creates the SD state)
        // Note: initiateSuddenDeath makes 2 update calls. 
        // 1. To set 'vs_screen' and playlist.
        // 2. To set 'playing' (inside timeout). 
        // We are testing the first one mostly, but we can't easily wait for timeout in simple test without fake timers.
        // However, the function awaits the first update.

        const firstCallArgs = mockUpdate.mock.calls[0]
        const payload = firstCallArgs[1]

        console.log('Update Payload:', JSON.stringify(payload, null, 2))

        // Check for undefined
        // The 'playlist' array in payload should NOT have 'extra' key if it was undefined
        const playlist = payload['game_state/playlist']
        expect(playlist).toBeDefined()
        expect(playlist[0].id).toBe('old1')
        expect(playlist[0]).not.toHaveProperty('extra') // Should be stripped
        expect(playlist[0].extra).toBeUndefined()

        // Also ensure no top-level undefineds
        Object.values(payload).forEach(val => {
            expect(val).not.toBeUndefined()
        })
    })
})
