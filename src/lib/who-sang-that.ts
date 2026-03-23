import { fetchArtistPhoto } from './artist-photos'
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

function chooseImposterArtist(correctArtist: string, artistPool: string[]): string {
    const normalizedCorrectArtist = correctArtist.toLowerCase().trim()
    const mergedPool = [...artistPool, ...FALLBACK_ARTISTS]
    const uniquePool = [...new Set(mergedPool.map(name => name.trim()).filter(Boolean))]
    const imposters = uniquePool.filter(name => name.toLowerCase() !== normalizedCorrectArtist)

    if (imposters.length === 0) return 'Unknown Artist'
    return imposters[Math.floor(Math.random() * imposters.length)]
}

export async function buildWhoSangThatExtra(
    song: SongLike,
    artistPool: string[],
    cachedLyrics?: string | null
): Promise<{ extra: WhoSangThatExtra, lyricsText: string | null }> {
    const lyricsText = cachedLyrics ?? await fetchLyrics(song.artist_name, song.track_name).catch(() => null)
    const excerpt = lyricsText ? extractWhoSangThatExcerpt(lyricsText) : []
    const imposterName = chooseImposterArtist(song.artist_name, artistPool)

    const [correctPhoto, imposterPhoto] = await Promise.all([
        fetchArtistPhoto(song.artist_name).catch(() => null),
        fetchArtistPhoto(imposterName).catch(() => null)
    ])

    const correct = { name: song.artist_name, photo: correctPhoto }
    const imposter = { name: imposterName, photo: imposterPhoto }
    const options = Math.random() < 0.5 ? [correct, imposter] : [imposter, correct]

    return {
        extra: { excerpt, options },
        lyricsText,
    }
}
