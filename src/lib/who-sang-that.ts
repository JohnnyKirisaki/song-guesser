import { fetchArtistPhoto, fetchSpotifyArtistPhoto } from './artist-photos'
import { fetchLyrics } from './lyrics'
import { detectLanguage, languageFromGenres, baseLang, LanguageCode } from './language-detector'

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
    const allCandidates = artistPool.filter(a => a.name.toLowerCase().trim() !== normalizedCorrectArtist)
    if (allCandidates.length === 0) return { name: 'Various Artists', spotify_artist_id: null }

    // 2. Language hard-filter with three tiers. Pairing a pt-pt track
    //    with an English-only artist used to make the round trivial; pt-pt
    //    with pt-br is better, but we still prefer same-region when
    //    possible (Chico da Tina + Fado act beats Chico da Tina + Anitta).
    //      tier 1: exact language code match (pt-pt ↔ pt-pt)
    //      tier 2: same base language family (pt-pt ↔ pt-br / bare 'pt')
    //      tier 3: full pool — last resort so we don't hand back
    //              "Various Artists" just because the room happens to
    //              have only one artist in that language family.
    const exactLang = allCandidates.filter(a => a._lang === lang)
    const base = baseLang(lang)
    const sameFamily = base
        ? allCandidates.filter(a => a._lang != null && baseLang(a._lang) === base)
        : []
    const candidates =
        exactLang.length > 0 ? exactLang
            : sameFamily.length > 0 ? sameFamily
                : allCandidates
    const pickedFromExactOrFamily = candidates !== allCandidates

    // 3. Score each remaining candidate by genre overlap / recency.
    const scoredCandidates = candidates.map(cand => {
        let score = 0

        // Inside the exact-match or family pool, language doesn't add
        // score (everyone qualifies on lang alone). If we fell back to
        // the full pool, give a small reward for same base language
        // (shouldn't normally happen — tier 2 catches that — but the
        // guard stops us from randomly picking an untagged `_lang`
        // artist over a legitimate near-match).
        if (!pickedFromExactOrFamily) {
            if (cand._lang === lang) score += 100
            else if (cand._lang && cand._lang !== lang) score -= 200
        }

        // Genre overlap weight — now the primary tiebreaker within lang.
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
        
        // Find correct artist's pool data (genres + cached language tag).
        const correctArtistPoolData = artistPool.find(a => a.name.toLowerCase().trim() === song.artist_name.toLowerCase().trim())
        const genres = correctArtistPoolData?._genres || []

        // LANGUAGE DETECTION — order by signal strength:
        //   1. Genre string (unambiguous: 'sertanejo' → pt, 'k-pop' → ko)
        //   2. Full lyrics text (much richer than the 2-line excerpt)
        //   3. Excerpt text (small sample, weakest)
        //   4. The artist's own pool _lang tag (may itself be genre-inferred)
        // A 2-line excerpt in English ("I love you / forever and ever")
        // inside an otherwise-Portuguese song used to fall through to 'en'
        // and silently pair the round with an English-only imposter.
        const lang: LanguageCode =
            languageFromGenres(genres) ??
            (text ? detectLanguage(text) : null) ??
            (excerpt.length > 0 ? detectLanguage(excerpt.join(' ')) : null) ??
            correctArtistPoolData?._lang ??
            'en'

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
