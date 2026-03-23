import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, get, update } from 'firebase/database'
import { SongItem } from '@/lib/game-logic'
import { buildWhoSangThatExtra } from '@/lib/who-sang-that'

type RoomSong = {
    artist_name?: string
}

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
            get(ref(db, `rooms/${roomCode}`)),
            get(ref(db, `room_secrets/${roomCode}`))
        ])

        if (!roomSnap.exists()) {
            return NextResponse.json({ error: 'Room not found' }, { status: 404 })
        }

        if (!secretsSnap.exists()) {
            return NextResponse.json({ error: 'Room secrets not found' }, { status: 404 })
        }

        const roomData = roomSnap.val()
        const secrets = secretsSnap.val() as Record<string, SongItem>
        const existingExtras = roomData.who_sang_that_extras || {}
        const lyricsCache = roomData.lyrics_cache || {}
        const artistPool = [...new Set(
            Object.values(roomData.songs || {})
                .map((song: RoomSong) => song.artist_name?.trim())
                .filter((name): name is string => !!name)
        )]

        const updates: Record<string, unknown> = {}
        const hydratedSongIds: string[] = []

        for (const roundIndex of normalizedIndices) {
            const song = secrets[String(roundIndex)]
            if (!song?.id) continue

            const existing = existingExtras[song.id]
            const hasOptions = Array.isArray(existing?.options) && existing.options.length > 0
            if (hasOptions) continue

            const cachedLyrics = typeof lyricsCache[song.id] === 'string' ? lyricsCache[song.id] : null
            const { extra, lyricsText } = await buildWhoSangThatExtra(song, artistPool, cachedLyrics)

            updates[`rooms/${roomCode}/who_sang_that_extras/${song.id}`] = extra
            if (lyricsText && !cachedLyrics) {
                updates[`rooms/${roomCode}/lyrics_cache/${song.id}`] = lyricsText
            }

            hydratedSongIds.push(song.id)
        }

        if (Object.keys(updates).length > 0) {
            await update(ref(db), updates)
        }

        return NextResponse.json({
            success: true,
            hydratedSongIds,
            roundIndices: normalizedIndices,
        })
    } catch (error: unknown) {
        console.error('Who Sang That extras error:', error)
        const message = error instanceof Error ? error.message : 'Unknown error'
        return NextResponse.json({ error: message }, { status: 500 })
    }
}
