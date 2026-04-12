import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, get, update } from 'firebase/database'
import { SongItem } from '@/lib/game-logic'
import { buildWhoSangThatExtra } from '@/lib/who-sang-that'
import { getArtistMetadataBatch } from '@/lib/artist-metadata'
import { asyncPool } from '@/lib/async-utils'

const WHO_SANG_THAT_RECENT_OPTION_LIMIT = 15

type RoomSong = {
    artist_name?: string
    spotify_artist_id?: string | null
}

function getRecentOptionNames(
    secrets: Record<string, SongItem>,
    existingExtras: Record<string, { options?: Array<{ name?: string }> }>,
    roundIndex: number
): string[] {
    const recent: string[] = []

    for (let index = Math.max(0, roundIndex - 10); index < roundIndex; index++) {
        const song = secrets[String(index)]
        if (!song?.id) continue

        const options = existingExtras[song.id]?.options || []
        recent.push(...options.map(option => option?.name).filter((name): name is string => !!name))
    }

    return recent.slice(-WHO_SANG_THAT_RECENT_OPTION_LIMIT)
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
        
        // --- START LOBBY INTELLIGENCE ---
        const roomSongs = Object.values(roomData.songs || {}) as any[]
        const artistGroups = new Map<string, { name: string; spotify_artist_id?: string | null; titles: string[] }>()
        roomSongs.forEach(song => {
            if (!song.artist_name) return
            const key = song.artist_name.toLowerCase().trim()
            if (!artistGroups.has(key)) {
                artistGroups.set(key, { 
                    name: song.artist_name, 
                    spotify_artist_id: song.spotify_artist_id || null,
                    titles: [] 
                })
            }
            artistGroups.get(key)!.titles.push(song.track_name || '')
        })

        const metadataMap = await getArtistMetadataBatch(Array.from(artistGroups.values()))

        const artistPool = Array.from(artistGroups.values()).map(a => {
            const meta = metadataMap[a.name]
            return {
                name: a.name,
                spotify_artist_id: a.spotify_artist_id ?? null,
                _lang: meta?.lang || 'en',
                _genres: meta?.genres || []
            }
        })
        // --- END LOBBY INTELLIGENCE ---

        const updates: Record<string, unknown> = {}
        const hydratedSongIds: string[] = []

        await asyncPool(3, normalizedIndices, async (roundIndex: number) => {
            const song = secrets[String(roundIndex)]
            if (!song?.id) return

            const existing = existingExtras[song.id]
            const hasOptions = Array.isArray(existing?.options) && existing.options.length > 0
            if (hasOptions) return

            const cachedLyrics = typeof lyricsCache[song.id] === 'string' ? lyricsCache[song.id] : null
            const recentOptionNames = getRecentOptionNames(secrets, existingExtras, roundIndex)
            const { extra, lyricsText } = await buildWhoSangThatExtra(song, artistPool, cachedLyrics, recentOptionNames)

            updates[`rooms/${roomCode}/who_sang_that_extras/${song.id}`] = extra
            if (lyricsText && !cachedLyrics) {
                updates[`rooms/${roomCode}/lyrics_cache/${song.id}`] = lyricsText
            }

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
        console.error('Who Sang That extras error:', error)
        const message = error instanceof Error ? error.message : 'Unknown error'
        return NextResponse.json({ error: message }, { status: 500 })
    }
}
