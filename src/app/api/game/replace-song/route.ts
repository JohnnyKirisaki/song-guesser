import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, get, update } from 'firebase/database'
import { SongItem } from '@/lib/game-logic'
import { fetchLyrics } from '@/lib/lyrics'
import { resolveSingleTrack } from '@/lib/deezer'

const normalizePreview = (url: string) => url.replace(/^http:\/\//i, 'https://').trim()

const isPreviewExpiringSoon = (url: string, leewaySeconds = 90) => {
    const matchExp = url.match(/exp=(\d+)/)
    if (!matchExp) return false
    const expTime = parseInt(matchExp[1], 10)
    if (!expTime || Number.isNaN(expTime)) return false
    const nowSeconds = Math.floor(Date.now() / 1000)
    return expTime <= nowSeconds + leewaySeconds
}

const hasUsablePreview = (url?: string | null) => {
    if (typeof url !== 'string') return false
    const normalized = normalizePreview(url)
    if (!normalized.startsWith('http')) return false
    return !isPreviewExpiringSoon(normalized)
}

export async function POST(request: Request) {
    try {
        const { roomCode, roundIndex } = await request.json()
        const parsedRoundIndex = Number(roundIndex)

        if (!roomCode || Number.isNaN(parsedRoundIndex) || parsedRoundIndex < 0) {
            return NextResponse.json({ error: 'Missing/invalid roomCode or roundIndex' }, { status: 400 })
        }

        const roomRef = ref(db, `rooms/${roomCode}`)
        const secretRef = ref(db, `room_secrets/${roomCode}/${parsedRoundIndex}`)
        const [roomSnap, secretSnap] = await Promise.all([get(roomRef), get(secretRef)])
        const roomData = roomSnap.val()

        if (!roomData) return NextResponse.json({ error: 'Room not found' }, { status: 404 })
        if (!secretSnap.exists()) return NextResponse.json({ error: 'Secret song not found for round' }, { status: 404 })

        const allSongs = Object.values(roomData.songs || {}) as SongItem[]
        const secretSong = secretSnap.val() as SongItem
        const isLyricsOnly = roomData.settings?.mode === 'lyrics_only'
        const isSuddenDeath = !!roomData.game_state?.is_sudden_death

        const toPublicPlaylistSong = (song: SongItem) => {
            if (!isSuddenDeath) return song
            return {
                id: song.id,
                picked_by_user_id: song.picked_by_user_id,
                preview_url: song.preview_url,
                artist_name: '???',
                track_name: '???',
                cover_url: '',
                spotify_uri: ''
            }
        }

        const ensurePlayableSong = async (song: SongItem): Promise<SongItem | null> => {
            const preview = typeof song.preview_url === 'string' ? normalizePreview(song.preview_url) : ''
            if (hasUsablePreview(preview)) {
                return { ...song, preview_url: preview }
            }

            const resolved = await resolveSingleTrack({
                artist: song.artist_name,
                title: song.track_name
            })
            const resolvedPreview = resolved?.deezer?.preview_url
                ? normalizePreview(resolved.deezer.preview_url)
                : ''

            if (!hasUsablePreview(resolvedPreview)) {
                return null
            }

            return {
                ...song,
                preview_url: resolvedPreview,
                spotify_uri: resolved?.deezer?.id || song.spotify_uri
            }
        }

        const applySongAtRound = async (
            song: SongItem,
            kind: 'refreshed' | 'replaced',
            lyrics: string | null = null
        ) => {
            const updates: Record<string, unknown> = {
                [`room_secrets/${roomCode}/${parsedRoundIndex}`]: song,
                [`rooms/${roomCode}/game_state/playlist/${parsedRoundIndex}`]: toPublicPlaylistSong(song),
                [`rooms/${roomCode}/songs/${song.id}/preview_url`]: song.preview_url
            }
            if (song.spotify_uri) {
                updates[`rooms/${roomCode}/songs/${song.id}/spotify_uri`] = song.spotify_uri
            }
            if (lyrics) {
                updates[`rooms/${roomCode}/lyrics_cache/${song.id}`] = lyrics
            }

            await update(ref(db), updates)
            return NextResponse.json({ success: true, kind, song })
        }

        // 1) Try to keep the same song by refreshing/repairing its preview.
        const refreshedSecret = await ensurePlayableSong(secretSong)
        if (refreshedSecret) {
            if (isLyricsOnly) {
                let lyrics = roomData.lyrics_cache?.[refreshedSecret.id] || null
                if (!lyrics) {
                    lyrics = await fetchLyrics(refreshedSecret.artist_name, refreshedSecret.track_name)
                }
                if (!lyrics) {
                    // If lyrics mode and we can't get lyrics, fall through to replacement search.
                } else {
                    return applySongAtRound(refreshedSecret, 'refreshed', lyrics)
                }
            } else {
                return applySongAtRound(refreshedSecret, 'refreshed')
            }
        }

        const usedSongIds = new Set<string>()

        // Collect used IDs from playlist
        const playlistRaw = roomData.game_state?.playlist || []
        const playlistItems = Array.isArray(playlistRaw) ? playlistRaw : Object.values(playlistRaw)
        playlistItems.forEach((s: SongItem) => usedSongIds.add(s.id))

        // Find standard replacement
        const pool = allSongs.filter(s => !usedSongIds.has(s.id)).sort(() => 0.5 - Math.random())

        // If pool empty, try ANY song (duplicates allowed if desperate)
        // But for now, strict unique.
        if (pool.length === 0) {
            return NextResponse.json({ error: 'No replacement songs available' }, { status: 400 })
        }

        let replacement: SongItem | null = null
        let lyrics: string | null = null

        // Try to find one with audio (and lyrics if needed)
        for (const candidate of pool) {
            const playableCandidate = await ensurePlayableSong(candidate)
            if (!playableCandidate?.preview_url) continue

            if (isLyricsOnly) {
                const l = await fetchLyrics(playableCandidate.artist_name, playableCandidate.track_name)
                if (!l) continue
                lyrics = l
            }

            replacement = playableCandidate
            break
        }

        if (!replacement) {
            return NextResponse.json({ error: 'Could not find a valid replacement with audio' }, { status: 500 })
        }

        return applySongAtRound(replacement, 'replaced', lyrics)
    } catch (e: unknown) {
        console.error('Replace Song Error:', e)
        const message = e instanceof Error ? e.message : 'Unknown error'
        return NextResponse.json({ error: message }, { status: 500 })
    }
}
