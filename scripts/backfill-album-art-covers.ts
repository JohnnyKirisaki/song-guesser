/**
 * backfill-album-art-covers.ts
 * Backfills album_cover_url for songs in a room using Spotify album search.
 *
 * Run with:
 *   npx ts-node scripts/backfill-album-art-covers.ts ROOMCODE
 */

import { initializeApp } from 'firebase/app'
import { getDatabase, get, ref, update } from 'firebase/database'

const firebaseConfig = {
    apiKey: 'AIzaSyDq0X64s2w532lTZ8XcTdLU8JRzOAabEHw',
    authDomain: 'beatbattle-e02aa.firebaseapp.com',
    databaseURL: 'https://beatbattle-e02aa-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'beatbattle-e02aa',
    storageBucket: 'beatbattle-e02aa.firebasestorage.app',
    messagingSenderId: '1041147594033',
    appId: '1:1041147594033:web:5b3ce470b89f221b695c10'
}

type RoomSong = {
    id: string
    artist_name?: string
    album_name?: string | null
    album_cover_url?: string | null
    cover_url?: string | null
}

type GamePlaylistSong = {
    id?: string
    cover_url?: string | null
}

type SpotifyAlbum = {
    name?: string
    artists?: Array<{ name?: string }>
    images?: Array<{ url?: string }>
}

function normalize(str: string): string {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function stripEditionWords(str: string): string {
    return str
        .replace(/\s*\([^)]*\)/g, ' ')
        .replace(/\s*\[[^\]]*\]/g, ' ')
        .replace(/\s*-\s*(deluxe|expanded|complete|platinum|special|collector'?s?|anniversary|bonus|tour|edition|version).*$/gi, ' ')
        .replace(/\s+(?:version|deluxe|expanded|complete|platinum|special|collector'?s?|anniversary|bonus|tour|edition)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

async function getSpotifyAccessToken(): Promise<string> {
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET

    if (!clientId || !clientSecret) {
        throw new Error('Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET')
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
    })

    if (!res.ok) {
        throw new Error(`Spotify token request failed (${res.status})`)
    }

    const data = await res.json() as { access_token?: string }
    if (!data.access_token) {
        throw new Error('Spotify token missing in response')
    }

    return data.access_token
}

function scoreAlbumCandidate(albumName: string, artistName: string, album: SpotifyAlbum): number {
    const targetAlbum = normalize(stripEditionWords(albumName))
    const targetArtist = normalize(artistName)
    const candAlbum = normalize(stripEditionWords(album.name || ''))
    const candArtist = normalize(album.artists?.[0]?.name || '')

    let score = 0
    if (candAlbum === targetAlbum) score += 100
    if (candArtist === targetArtist) score += 80
    if (candAlbum.includes(targetAlbum) || targetAlbum.includes(candAlbum)) score += 25
    if (candArtist.includes(targetArtist) || targetArtist.includes(candArtist)) score += 20
    if (album.images?.[0]?.url) score += 10
    return score
}

async function fetchAlbumCoverUrl(accessToken: string, albumName: string, artistName: string): Promise<string | null> {
    const query = `album:${albumName} artist:${artistName}`
    const url = new URL('https://api.spotify.com/v1/search')
    url.searchParams.set('q', query)
    url.searchParams.set('type', 'album')
    url.searchParams.set('limit', '10')

    const res = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${accessToken}` },
    })

    if (!res.ok) return null

    const data = await res.json() as { albums?: { items?: SpotifyAlbum[] } }
    const items = data.albums?.items || []
    if (items.length === 0) return null

    const ranked = items
        .map(album => ({ album, score: scoreAlbumCandidate(albumName, artistName, album) }))
        .sort((a, b) => b.score - a.score)

    return ranked[0]?.album.images?.[0]?.url || null
}

async function main() {
    const roomCode = process.argv[2]?.trim()
    if (!roomCode) {
        throw new Error('Usage: npx ts-node scripts/backfill-album-art-covers.ts ROOMCODE')
    }

    const app = initializeApp(firebaseConfig)
    const db = getDatabase(app)
    const accessToken = await getSpotifyAccessToken()

    const [roomSnap, secretsSnap] = await Promise.all([
        get(ref(db, `rooms/${roomCode}`)),
        get(ref(db, `room_secrets/${roomCode}`))
    ])

    if (!roomSnap.exists()) {
        throw new Error(`Room ${roomCode} not found`)
    }

    const roomData = roomSnap.val()
    const songs = roomData.songs || {}
    const secrets = secretsSnap.exists() ? secretsSnap.val() : {}
    const gamePlaylist = roomData.game_state?.playlist || []
    const isAlbumArtMode = roomData.settings?.mode === 'album_art'

    const updates: Record<string, string> = {}
    let updatedCount = 0

    for (const [songId, rawSong] of Object.entries(songs) as Array<[string, RoomSong]>) {
        const song = rawSong || {} as RoomSong
        const albumName = song.album_name?.trim()
        const artistName = song.artist_name?.trim()

        if (!albumName || !artistName) continue

        const coverUrl = await fetchAlbumCoverUrl(accessToken, albumName, artistName)
        if (!coverUrl) continue

        updates[`rooms/${roomCode}/songs/${songId}/album_cover_url`] = coverUrl
        updatedCount++

        for (const [index, secretSong] of Object.entries(secrets) as Array<[string, RoomSong]>) {
            if (secretSong?.id === songId) {
                updates[`room_secrets/${roomCode}/${index}/album_cover_url`] = coverUrl
            }
        }

        if (isAlbumArtMode) {
            ;(gamePlaylist as GamePlaylistSong[]).forEach((playlistSong, index) => {
                if (playlistSong?.id === songId) {
                    updates[`rooms/${roomCode}/game_state/playlist/${index}/cover_url`] = coverUrl
                }
            })
        }
    }

    if (Object.keys(updates).length === 0) {
        console.log(`No album cover updates found for room ${roomCode}.`)
        return
    }

    await update(ref(db), updates)
    console.log(`Updated ${updatedCount} song(s) in room ${roomCode}.`)
}

main().catch((err) => {
    console.error('Failed to backfill album art covers:', err)
    process.exit(1)
})
