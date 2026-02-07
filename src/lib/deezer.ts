import { normalizeForSearch, scoreTrackMatch, normalizeForCompare } from './scoring'
import fs from 'fs'
import path from 'path'

const DEEZER_API = 'https://api.deezer.com/search'
const CACHE = new Map<string, any>()

type ResolvedTrack = {
    input: {
        artist: string
        title: string
        durationMs?: number
        isrc?: string
        album?: string
        year?: string
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
    candidates?: any[] // Rejected candidates for debugging
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
// Retry Helper
async function fetchWithRetry(url: string, retries = 7): Promise<any> {
    for (let i = 0; i < retries; i++) {
        try {
            // Next.js patches fetch() to cache by default. We MUST disable this for external APIs 
            // to avoid sticking to transient 404s/errors.
            const res = await fetch(url, { cache: 'no-store' })
            if (!res.ok) throw new Error(`API Error: ${res.status} ${res.statusText}`)

            const data = await res.json()

            // Handle Deezer specific errors (Quota Limit)
            // Error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 }
            if (data.error && data.error.code === 4) {
                console.warn(`[Deezer] Quota limit exceeded. Retrying (${i + 1}/${retries})...`)
                throw new Error('Deezer API Quota Exceeded (Code 4)')
            }

            return data
        } catch (err: any) {
            console.warn(`[Deezer] Fetch attempt ${i + 1} failed for ${url}: ${err.message}`)
            if (i === retries - 1) throw err
            // Exponential backoff: 1s, 2s... up to 7s
            await new Promise(r => setTimeout(r, 1000 * (i + 1)))
        }
    }
}

// Single Track Resolver
async function resolveSingleTrack(track: { artist: string, title: string, durationMs?: number, isrc?: string, album?: string, year?: string }): Promise<ResolvedTrack> {
    const cacheKey = `deezer:${normalizeForCompare(track.artist)}|${normalizeForCompare(track.title)}|${track.isrc || ''}`
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

    // Aggressive Title Cleaning (for "Link Up (Metro Boomin...) - Spider-Verse...")
    // Take the chunk before the first (, [, or -
    const aggressiveTitle = track.title.split(/[(\[-]/)[0].trim()
    const cleanQuery = (str: string) => str.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()

    const queries = [
        `artist:"${track.artist}" track:"${track.title}"`,
        `artist:"${track.artist}" track:"${aggressiveTitle}"`, // New Aggressive Strategy
        featurePart ? `"${track.artist}" "${cleanTitle}" "${featurePart}"` : `"${track.artist}" "${track.title}"`,
        `artist:"${track.artist}" track:"${cleanTitle}"`,
        `"${track.artist}" "${aggressiveTitle}"`, // Quoted Aggressive
        `${cleanQuery(track.artist)} ${cleanQuery(aggressiveTitle)}`, // Symbol-free Aggressive
        `"${track.artist} ${track.title}"`,
        `"${track.artist}" "${track.title}"`,
        `${track.artist} ${track.title}`,
        `${cleanQuery(track.artist)} ${cleanQuery(track.title)}`, // Symbol-free Full
        `artist:"${normArtist}" track:"${normTitle}"`,
        `artist:"${normArtist}" track:"${titleWithoutFeatures}"`,
        `${normArtist} ${titleWithoutFeatures}`,
        `${normArtist.replace(/\$/g, 's')} ${titleWithoutFeatures}`,
        titleWithoutFeatures
    ]

    let candidates: any[] = []
    let lastError: string | null = null
    const queriesUsed: string[] = []

    // --- 0. ISRC Match (Golden Ticket) ---
    if (track.isrc) {
        // User suggested: /track/isrc:<ISRC>
        const isrcUrl = `https://api.deezer.com/track/isrc:${track.isrc}`
        queriesUsed.push(`Direct ISRC: ${track.isrc}`)

        try {
            // Note: This endpoint returns the object directly, or an error field
            const data = await fetchWithRetry(isrcUrl)

            if (data && data.id && !data.error) {
                const match = data
                // Double check artist just in case (though ISRC should be unique, sometimes mapping is weird)
                // TRUST THE ISRC. It is a unique identifier.
                // If Deezer returns a track for this ISRC, it is the correct recording.
                // Ignoring metadata mismatches (e.g. "Arcane" vs "Ashnikko") because the audio is the same.
                console.log(`[Resolver] ISRC HIT: ${track.isrc} -> ${match.title}`)
                const result: ResolvedTrack = {
                    input: track,
                    resolved: true,
                    deezer: {
                        id: match.id.toString(),
                        title: match.title,
                        artist: match.artist.name,
                        preview_url: match.preview,
                        cover_url: match.album?.cover_xl || match.album?.cover_big,
                        duration: match.duration,
                        link: match.link
                    },
                    score: 100,
                    warnings: ['ISRC Match'],
                    candidates: [],
                    debug: { queriesUsed: [`isrc:${track.isrc}`], candidatesFound: 1 }
                }
                CACHE.set(cacheKey, result)
                return result
            } else if (data.error) {
                console.warn(`[Resolver] ISRC Lookup Error for ${track.isrc}: ${data.error.message || data.error}`)
            }
        } catch (e: any) {
            console.warn(`[Resolver] ISRC Lookup Failed for ${track.isrc}:`, e.message)
        }
    }

    // Try Deezer Text Search (Fallback)
    for (const q of queries) {
        queriesUsed.push(q)
        try {
            const data = await fetchWithRetry(`${DEEZER_API}?q=${encodeURIComponent(q)}&limit=50`)
            if (data.data && data.data.length > 0) {
                candidates = data.data

                break
            }
        } catch (e: any) {
            console.warn(`[Deezer] Search failed for ${q}:`, e)
            lastError = e.message
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

        let { score, reasons } = scoreTrackMatch(track, candidateInfo)

        // --- Metadata Bonuses (Album & Year) ---
        if (track.album && cand.album && cand.album.title) {
            const srcAlbum = normalizeForCompare(track.album)
            const candAlbum = normalizeForCompare(cand.album.title)

            // Exact album match is huge +10
            if (srcAlbum === candAlbum || candAlbum.includes(srcAlbum)) {
                score += 10
                reasons.push("Album match")
                // Also overrides "Unexpected version" penalties if album matches
                if (reasons.some(r => r.includes('Unexpected version'))) {
                    score += 15 // Refund penalty (+20 was penalty, but maybe +15 is enough to fix)
                    reasons.push("Album confirms version")
                }
            }
        }

        // Year check (if Spotify gave us a year)
        // Deezer API usually returns 'release_date', need to check if cand has it
        // Note: searching usually returns minimal fields. If release_date is missing, ignore.
        // Assuming 'cand.album.release_date' might exist or we might not have it in search results.
        // Checking Deezer API docs: 'album' object in search has 'title', 'cover'. 'release_date' is on track object?
        // Usually search results don't have release_date. We'd need to fetch track details.
        // Skipping year check for now to avoid specific API call overhead per candidate.



        if (score > bestScore) {
            bestScore = score
            bestReasons = reasons
            bestMatch = cand
        }
    }

    // Capture candidates with their scores for debugging
    const debugCandidates = candidates.map(c => {
        const info = {
            title: c.title,
            artist: c.artist.name,
            duration: c.duration,
            rank: c.rank,
            contributors: c.contributors || []
        }
        let { score, reasons } = scoreTrackMatch(track, info)
        if (track.album && c.album && c.album.title) {
            const srcAlbum = normalizeForCompare(track.album)
            const candAlbum = normalizeForCompare(c.album.title)
            if (srcAlbum === candAlbum || candAlbum.includes(srcAlbum)) {
                score += 10
                reasons.push("Album match")
            }
        }
        return {
            ...c,
            _score: score,
            _reasons: reasons
        }
    }).sort((a, b) => b._score - a._score) // Sort by score descending

    // Debug Log for rejected or low-score tracks
    if (bestScore <= 40) {
        console.log(`[Resolver] REJECTED: ${track.artist} - ${track.title} | Best Score: ${bestScore} | Reasons: ${bestReasons.join(', ') || 'No candidates found'}`)
        if (bestMatch) console.log(`   -> Best Candidate: ${bestMatch.title} by ${bestMatch.artist.name}`)
    } else {

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
            candidates: debugCandidates,
            debug: { queriesUsed, candidatesFound: candidates.length }
        }
    } else {
        const failReason = !bestMatch
            ? (lastError ? `Error: ${lastError}` : 'No candidates found')
            : !artistMatched ? 'Artist mismatch'
                : 'Score too low'
        result = {
            input: track,
            resolved: false,
            score: bestScore,
            warnings: bestReasons.length > 0 ? [...bestReasons, failReason] : [failReason],
            candidates: debugCandidates,
            debug: { queriesUsed, candidatesFound: candidates.length }
        }
    }

    CACHE.set(cacheKey, result)
    return result
}

// Bulk Resolver
export async function resolvePlaylist(tracks: any[], clearLog: boolean = false): Promise<ResolvedTrack[]> {
    console.log(`[Resolver] Processing ${tracks.length} tracks... (Clear Log: ${clearLog})`)

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

    console.log(`[Resolver] Finished. Input: ${tracks.length}, Results: ${results.length}.`)

    // --- Generate Debug Report ---
    const failures = results.filter(r => !r.resolved)
    if (failures.length > 0) {
        const logPath = path.join(process.cwd(), 'import_debug.txt')
        const timestamp = new Date().toISOString()

        let report = ''
        // Only add header if clearing log
        if (clearLog) {
            report += `Import Debug Report - ${timestamp}\n`
            report += `==================================================\n\n`
        }

        report += `Batch Results (${results.length} tracks) - ${timestamp}\n`
        report += `Guaranteed Failures: ${failures.length}\n`
        report += `--------------------------------------------------\n`

        failures.forEach(fail => {
            report += `[FAILED] "${fail.input.title}" by "${fail.input.artist}"\n`
            if (fail.input.isrc) report += `  ISRC: ${fail.input.isrc}\n`
            if (fail.input.album) report += `  Album: ${fail.input.album}\n`
            report += `  Error: ${fail.warnings.join(', ')}\n`
            report += `  Queries Tried:\n    ${fail.debug?.queriesUsed.join('\n    ')}\n`

            if (fail.candidates && fail.candidates.length > 0) {
                report += `  Candidates Found (${fail.candidates.length}):\n`
                // Show top 5 rejected candidates
                fail.candidates.slice(0, 5).forEach((c: any, idx: number) => {
                    report += `    ${idx + 1}. "${c.title}" by "${c.artist.name}"\n`
                    report += `       Score: ${c._score}\n`
                    report += `       Link: ${c.link}\n`
                    report += `       Reasons: ${c._reasons.join(', ')}\n`
                })
            } else {
                report += `  No candidates found on Deezer.\n`
            }
            report += `--------------------------------------------------\n\n`
        })

        try {
            if (clearLog) {
                fs.writeFileSync(logPath, report)
                console.log(`[Resolver] Overwrote failure report to ${logPath}`)
            } else {
                fs.appendFileSync(logPath, report)
                console.log(`[Resolver] Appended failure report to ${logPath}`)
            }
        } catch (err) {
            console.error('[Resolver] Failed to write debug report:', err)
        }
    }

    return results
}
