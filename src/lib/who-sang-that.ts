import { fetchArtistPhoto, fetchSpotifyArtistPhoto } from './artist-photos'
import { fetchLyrics } from './lyrics'
import { detectLanguage, LanguageCode } from './language-detector'

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
    spotify_artist_id: string | null
    _lang?: LanguageCode
    _genres?: string[]
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

function chooseImposterArtist(
    correctArtist: string,
    artistPool: ArtistPoolEntry[],
    lang: LanguageCode = 'en',
    avoidArtistNames: string[] = [],
    correctArtistGenres: string[] = []
): ArtistPoolEntry {
    const normalizedCorrectArtist = correctArtist.toLowerCase().trim()
    const avoidSet = new Set(avoidArtistNames.map(name => name.toLowerCase().trim()).filter(Boolean))

    // 1. Filter out the correct artist
    const candidates = artistPool.filter(a => a.name.toLowerCase().trim() !== normalizedCorrectArtist)
    if (candidates.length === 0) return { name: 'Various Artists', spotify_artist_id: null }

    // 2. Score each candidate based on Language and Genre overlap
    const scoredCandidates = candidates.map(cand => {
        let score = 0
        
        // Language weight (Most important)
        if (cand._lang === lang) {
            score += 100
        } else if (cand._lang && cand._lang !== lang) {
            // Strong penalty for known language mismatch
            score -= 200
        }
        
        // Genre overlap weight
        if (correctArtistGenres.length > 0 && cand._genres && cand._genres.length > 0) {
            const overlap = cand._genres.filter(g => correctArtistGenres.includes(g))
            score += overlap.length * 20
        }

        // Penalty for recently used distractors
        if (avoidSet.has(cand.name.toLowerCase().trim())) {
            score -= 50
        }

        // Add a tiny bit of randomness to break ties
        score += Math.random() * 5

        return { cand, score }
    })

    // Sort by score descending
    scoredCandidates.sort((a, b) => b.score - a.score)

    // Pick top candidate
    return scoredCandidates[0].cand
}

export async function buildWhoSangThatExtra(
    song: SongLike,
    artistPool: ArtistPoolEntry[],
    cachedLyrics?: string | null,
    avoidArtistNames: string[] = []
): Promise<{ extra: WhoSangThatExtra, lyricsText: string | null }> {
    const { extra, lyricsText } = await (async () => {
        const text = cachedLyrics ?? await fetchLyrics(song.artist_name, song.track_name).catch(() => null)
        const excerpt = text
            ? (() => {
                const extracted = extractWhoSangThatExcerpt(text)
                return extracted.length > 0 ? extracted : fallbackWhoSangThatExcerpt(text)
            })()
            : []
        
        // DETECT LANGUAGE & GENRE MATCHING
        const lang = detectLanguage(excerpt.join(' '))
        
        // Find correct artist's genres from pool
        const correctArtistPoolData = artistPool.find(a => a.name.toLowerCase().trim() === song.artist_name.toLowerCase().trim())
        const genres = correctArtistPoolData?._genres || []

        const imposter = chooseImposterArtist(song.artist_name, artistPool, lang, avoidArtistNames, genres)

        return {
            lyricsText: text,
            extra: { excerpt, imposter, lang }
        }
    })()

    const imposter = (extra as any).imposter as ArtistPoolEntry

    const [correctPhoto, imposterPhoto] = await Promise.all([
        (async () => {
            if (song.spotify_artist_id) {
                const p = await fetchSpotifyArtistPhoto(song.spotify_artist_id)
                if (p) return p
            }
            return fetchArtistPhoto(song.artist_name)
        })().catch(() => null),
        (async () => {
            if (imposter.spotify_artist_id) {
                const p = await fetchSpotifyArtistPhoto(imposter.spotify_artist_id)
                if (p) return p
            }
            return fetchArtistPhoto(imposter.name)
        })().catch(() => null)
    ])

    const correct = { name: song.artist_name, photo: correctPhoto }
    const imposterOption = { name: imposter.name, photo: imposterPhoto }
    
    // Shuffle options 50/50
    const options = Math.random() < 0.5 
        ? [correct, imposterOption] 
        : [imposterOption, correct]

    return {
        extra: { excerpt: extra.excerpt, options },
        lyricsText,
    }
}
