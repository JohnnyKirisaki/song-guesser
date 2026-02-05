import { normalizeForSearch, scoreTrackMatch, normalizeForCompare } from './scoring'

const DEEZER_API = 'https://api.deezer.com/search'
const CACHE = new Map<string, any>()

type ResolvedTrack = {
    input: {
        artist: string
        title: string
        durationMs?: number
    }
    resolved: boolean
    deezer?: {
        id: string
        title: string
        artist: string
        preview_url: string
        cover_url: string
        duration: number
        link: string
    }
    score: number
    warnings: string[]
    debug?: {
        queriesUsed: string[]
        candidatesFound: number
    }
}

// Concurrency Limiter
async function asyncPool<T>(poolLimit: number, items: any[], iteratorFn: (item: any) => Promise<T>): Promise<T[]> {
    const ret: Promise<T>[] = []
    const executing: Promise<T>[] = []
    for (const item of items) {
        const p = Promise.resolve().then(() => iteratorFn(item))
        ret.push(p)
        const e: Promise<any> = p.then(() => executing.splice(executing.indexOf(e), 1))
        executing.push(e)
        if (executing.length >= poolLimit) {
            await Promise.race(executing)
        }
    }
    return Promise.all(ret)
}

// Retry Helper
async function fetchWithRetry(url: string, retries = 3): Promise<any> {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url)
            if (!res.ok) throw new Error(`API Error: ${res.status}`)
            return await res.json()
        } catch (err) {
            if (i === retries - 1) throw err
            await new Promise(r => setTimeout(r, 1000 * (i + 1)))
        }
    }
}

// Single Track Resolver
async function resolveSingleTrack(track: { artist: string, title: string, durationMs?: number }): Promise<ResolvedTrack> {
    const cacheKey = `deezer:${normalizeForCompare(track.artist)}|${normalizeForCompare(track.title)}`
    if (CACHE.has(cacheKey)) return CACHE.get(cacheKey)

    const normArtist = normalizeForSearch(track.artist)
    const normTitle = normalizeForSearch(track.title)

    // Strip featured artist annotations for better matching
    // "song (feat. Artist)" or "song (with Artist)" → "song"
    const titleWithoutFeatures = normTitle
        .replace(/\s*\(feat\.?.*?\)/gi, '')
        .replace(/\s*\(with .*?\)/gi, '')
        .replace(/\s*\(ft\.?.*?\)/gi, '')
        .trim()

    // Fallback Queries
    const cleanTitle = track.title.replace(/\s*\(feat\.?.*?\)/gi, '').replace(/\s*\(with .*?\)/gi, '').replace(/\s*\(ft\.?.*?\)/gi, '').trim()
    const featurePart = track.title.match(/\((feat\.?|with|ft\.?)\s+([^)]+)\)/i)?.[2] || ''

    const queries = [
        `artist:"${track.artist}" track:"${track.title}"`,
        featurePart ? `"${track.artist}" "${cleanTitle}" "${featurePart}"` : `"${track.artist}" "${track.title}"`, // Specific feature search
        `artist:"${track.artist}" track:"${cleanTitle}"`, // Relaxed search
        `"${track.artist} ${track.title}"`,
        `"${track.artist}" "${track.title}"`,
        `${track.artist} ${track.title}`,
        `artist:"${normArtist}" track:"${normTitle}"`, // Exact as-is
        `artist:"${normArtist}" track:"${titleWithoutFeatures}"`, // Without features
        `${normArtist} ${titleWithoutFeatures}`, // Generic without features
        `${normArtist.replace(/\$/g, 's')} ${titleWithoutFeatures}`, // Symbol mapped
        titleWithoutFeatures // Title only fallback
    ]

    let candidates: any[] = []
    const queriesUsed: string[] = []

    // Try Deezer
    for (const q of queries) {
        queriesUsed.push(q)
        try {
            const data = await fetchWithRetry(`${DEEZER_API}?q=${encodeURIComponent(q)}&limit=10`)
            if (data.data && data.data.length > 0) {
                candidates = data.data
                console.log(`[Deezer] Query "${q}" → ${candidates.length} results`)
                console.log(`[Deezer]   Top 3: ${candidates.slice(0, 3).map((c: any) => `"${c.title}" by ${c.artist.name}`).join(', ')}`)
                break
            }
        } catch (e) {
            console.warn(`[Deezer] Search failed for ${q}:`, e)
        }
    }

    // Score Candidates
    let bestMatch: any = null
    let bestScore = -100
    let bestReasons: string[] = []

    for (const cand of candidates) {
        // Skip if no preview (fundamental requirement)
        if (!cand.preview) continue

        const candidateInfo = {
            title: cand.title,
            artist: cand.artist.name,
            duration: cand.duration,
            rank: cand.rank,
            contributors: cand.contributors || [] // Featured artists info
        }

        const { score, reasons } = scoreTrackMatch(track, candidateInfo)

        console.log(`[Resolver Candidate] ${cand.artist.name} - ${cand.title} | Score: ${score} | Reasons: ${reasons.join(', ')}`)

        if (score > bestScore) {
            bestScore = score
            bestReasons = reasons
            bestMatch = cand
        }
    }

    // Debug Log for rejected or low-score tracks
    if (bestScore <= 40) {
        console.log(`[Resolver] REJECTED: ${track.artist} - ${track.title} | Best Score: ${bestScore} | Reasons: ${bestReasons.join(', ') || 'No candidates found'}`)
        if (bestMatch) console.log(`   -> Best Candidate: ${bestMatch.title} by ${bestMatch.artist.name}`)
    } else {
        console.log(`[Resolver] MATCH: ${track.artist} - ${track.title} -> ${bestMatch.artist.name} - ${bestMatch.title} (${bestScore})`)
    }

    // Construct Result
    // Require artist match to prevent wrong-artist matches
    const artistMatched = bestReasons.some(r => r.includes('artist'))
    const passesThreshold = bestScore > 40 && artistMatched

    let result: ResolvedTrack;
    if (bestMatch && passesThreshold) {
        result = {
            input: track,
            resolved: true,
            deezer: {
                id: bestMatch.id.toString(),
                title: bestMatch.title,
                artist: bestMatch.artist.name,
                preview_url: bestMatch.preview,
                cover_url: bestMatch.album?.cover_xl || bestMatch.album?.cover_big,
                duration: bestMatch.duration,
                link: bestMatch.link
            },
            score: bestScore,
            warnings: bestReasons,
            debug: { queriesUsed, candidatesFound: candidates.length }
        }
    } else {
        const failReason = !bestMatch ? 'No candidates found' :
            !artistMatched ? 'Artist mismatch' :
                'Score too low'
        result = {
            input: track,
            resolved: false,
            score: bestScore,
            warnings: bestReasons.length > 0 ? [...bestReasons, failReason] : [failReason],
            debug: { queriesUsed, candidatesFound: candidates.length }
        }
    }

    CACHE.set(cacheKey, result)
    return result
}

// Bulk Resolver
export async function resolvePlaylist(tracks: any[]): Promise<ResolvedTrack[]> {
    console.log(`[Resolver] Processing ${tracks.length} tracks...`)

    // Concurrent limit: 2 (reduced from 5 to avoid rate limiting)
    const results = await asyncPool(2, tracks, async (track) => {
        try {
            return await resolveSingleTrack(track)
        } catch (e) {
            console.error(`[Resolver] Failed ${track.artist} - ${track.title}`, e)
            return {
                input: track,
                resolved: false,
                score: 0,
                warnings: ['Exception during resolution'],
                debug: { queriesUsed: [], candidatesFound: 0 }
            } as ResolvedTrack
        }
    })

    return results
}
