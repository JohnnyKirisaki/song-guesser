import { fetchArtistPhoto, fetchSpotifyArtistPhoto } from './artist-photos'
import { fetchLyrics } from './lyrics'

const FALLBACK_ARTISTS = ['Taylor Swift', 'Drake', 'Beyonce', 'Ed Sheeran', 'Ariana Grande', 'The Weeknd', 'Bad Bunny', 'Billie Eilish']
const FILLER_RE = /^(oh+|ah+|na+|la+|hey+|yeah+|uh+|mm+|hm+|woo+|ay+|yea+|ooh+|bah+|da+|doo+|sha+|bay+|whoa+|hmm+|mmm+|ohh+|yeh+|nah+|aye+|woah+|ooo+)[\s,!?.~\-*]*$/i

export type WhoSangThatOption = {
    name: string
    photo: string | null
}

export type WhoSangThatExtra = {
    excerpt: string[]
    options: WhoSangThatOption[]
}

type SongLike = {
    artist_name: string
    track_name: string
    spotify_artist_id?: string
}

type ArtistPoolEntry = {
    name: string
    spotify_artist_id?: string | null
}

export function extractWhoSangThatExcerpt(lyrics: string): string[] {
    const cleanLines = lyrics.split('\n').map(l => l.trim()).filter(l => {
        if (!l || l.length < 10) return false
        if (l.startsWith('[') || l.startsWith('(')) return false
        const words = l.split(/\s+/).filter(w => w.length > 0)
        if (words.length < 3) return false
        const nonFiller = words.filter(w => !FILLER_RE.test(w))
        return nonFiller.length >= 2
    })

    if (cleanLines.length === 0) return []
    if (cleanLines.length === 1) return [cleanLines[0]]

    const startIdx = Math.max(0, Math.floor(cleanLines.length * 0.2))
    const endIdx = Math.min(cleanLines.length - 2, Math.floor(cleanLines.length * 0.65))
    const pickIdx = endIdx > startIdx
        ? startIdx + Math.floor(Math.random() * (endIdx - startIdx + 1))
        : startIdx

    return [cleanLines[pickIdx], cleanLines[Math.min(pickIdx + 1, cleanLines.length - 1)]]
}

function fallbackWhoSangThatExcerpt(lyrics: string): string[] {
    const lines = lyrics
        .split('\n')
        .map(line => line.replace(/\[[^\]]*\]/g, '').trim())
        .filter(Boolean)

    if (lines.length === 0) return []
    if (lines.length === 1) return [lines[0]]
    return [lines[0], lines[1]]
}

function chooseImposterArtist(correctArtist: string, artistPool: ArtistPoolEntry[]): ArtistPoolEntry {
    const normalizedCorrectArtist = correctArtist.toLowerCase().trim()
    const mergedPool = [
        ...artistPool,
        ...FALLBACK_ARTISTS.map(name => ({ name, spotify_artist_id: null }))
    ]
    const uniquePool = Array.from(new Map(
        mergedPool
            .map(artist => ({ name: artist.name.trim(), spotify_artist_id: artist.spotify_artist_id ?? null }))
            .filter(artist => artist.name)
            .map(artist => [artist.name.toLowerCase(), artist])
    ).values())
    const imposters = uniquePool.filter(artist => artist.name.toLowerCase() !== normalizedCorrectArtist)

    if (imposters.length === 0) return { name: 'Unknown Artist', spotify_artist_id: null }
    return imposters[Math.floor(Math.random() * imposters.length)]
}

export async function buildWhoSangThatExtra(
    song: SongLike,
    artistPool: ArtistPoolEntry[],
    cachedLyrics?: string | null
): Promise<{ extra: WhoSangThatExtra, lyricsText: string | null }> {
    const lyricsText = cachedLyrics ?? await fetchLyrics(song.artist_name, song.track_name).catch(() => null)
    const excerpt = lyricsText
        ? (() => {
            const extracted = extractWhoSangThatExcerpt(lyricsText)
            return extracted.length > 0 ? extracted : fallbackWhoSangThatExcerpt(lyricsText)
        })()
        : []
    const imposter = chooseImposterArtist(song.artist_name, artistPool)

    const [correctPhoto, imposterPhoto] = await Promise.all([
        (song.spotify_artist_id
            ? fetchSpotifyArtistPhoto(song.spotify_artist_id)
            : fetchArtistPhoto(song.artist_name)).catch(() => null),
        (imposter.spotify_artist_id
            ? fetchSpotifyArtistPhoto(imposter.spotify_artist_id)
            : fetchArtistPhoto(imposter.name)).catch(() => null)
    ])

    const correct = { name: song.artist_name, photo: correctPhoto }
    const imposterOption = { name: imposter.name, photo: imposterPhoto }
    const options = Math.random() < 0.5 ? [correct, imposterOption] : [imposterOption, correct]

    return {
        extra: { excerpt, options },
        lyricsText,
    }
}
