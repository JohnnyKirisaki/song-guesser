import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, get, update } from 'firebase/database'
import { SongItem } from '@/lib/game-logic'
import { asyncPool } from '@/lib/async-utils'
import { generateEmojiPuzzle } from '@/lib/new-mode-extras'

/**
 * Per-round emoji puzzle generator.
 *
 * Game start used to generate every emoji round up-front, which regularly
 * pushed /api/game/start past Vercel's serverless timeout on long playlists
 * (Gemini free tier rate-limits hard). This endpoint moves that work to
 * per-round, letting /start return 200 in a predictable window.
 *
 * Clients (the host, specifically) POST this with the room code + the
 * round index(es) they want emoji for. The response is idempotent: songs
 * that already have extras are skipped, and the `generateEmojiPuzzle`
 * helper falls back to the local dictionary on Gemini failure so the
 * write always lands.
 */
export async function POST(request: Request) {
    try {
        const { roomCode, roundIndices } = await request.json()

        if (!roomCode || !Array.isArray(roundIndices) || roundIndices.length === 0) {
            return NextResponse.json({ error: 'Missing params' }, { status: 400 })
        }

        const normalizedIndices = [...new Set(
            roundIndices
                .map((value: unknown) => Number(value))
                .filter(value => Number.isInteger(value) && value >= 0)
        )]

        if (normalizedIndices.length === 0) {
            return NextResponse.json({ error: 'No valid round indices provided' }, { status: 400 })
        }

        const [roomSnap, secretsSnap] = await Promise.all([
            get(ref(db, `rooms/${roomCode}/emoji_charades_extras`)),
            get(ref(db, `room_secrets/${roomCode}`)),
        ])

        if (!secretsSnap.exists()) {
            return NextResponse.json({ error: 'Room secrets not found' }, { status: 404 })
        }

        const secrets = secretsSnap.val() as Record<string, SongItem>
        const existingExtras = (roomSnap.exists() ? roomSnap.val() : {}) as Record<string, { emojis?: string }>

        const updates: Record<string, unknown> = {}
        const hydratedSongIds: string[] = []

        // Serial pool (1) — Gemini free tier rate-limits aggressively; the
        // helper already retries 429s but bursting parallel requests just
        // burns the retry budget. Per-round this is one call most of the
        // time anyway.
        await asyncPool(1, normalizedIndices, async (roundIndex: number) => {
            const song = secrets[String(roundIndex)]
            if (!song?.id) return

            const existing = existingExtras[song.id]
            if (existing && typeof existing.emojis === 'string' && existing.emojis.length > 0) return

            const emojis = await generateEmojiPuzzle(song.track_name, song.artist_name)
            updates[`rooms/${roomCode}/emoji_charades_extras/${song.id}`] = { emojis }
            hydratedSongIds.push(song.id)
        })

        if (Object.keys(updates).length > 0) {
            await update(ref(db), updates)
        }

        return NextResponse.json({
            success: true,
            hydratedSongIds,
            roundIndices: normalizedIndices,
        })
    } catch (error: unknown) {
        console.error('Emoji extras error:', error)
        const message = error instanceof Error ? error.message : 'Unknown error'
        return NextResponse.json({ error: message }, { status: 500 })
    }
}
