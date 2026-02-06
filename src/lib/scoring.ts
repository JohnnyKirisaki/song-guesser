export type ScoringMode = 'normal' | 'rapid' | 'artist_only' | 'song_only' | 'lyrics_only'

// --- Normalization ---

// Minimal cleanup for Search Queries (keep special chars that might avail in search)
export function normalizeForSearch(str: string): string {
    return str.toLowerCase().replace(/\s+/g, ' ').trim()
}

// Strict cleanup for Comparison (map symbols, remove accents)
export function normalizeForCompare(str: string): string {
    return str
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove accents
        .replace(/[&]/g, 'and')
        .replace(/[^a-z0-9$ ]/g, '') // Keep $ and alphanumeric
        .replace(/\s+/g, ' ')
        .trim()
}

// Strip common extras from song titles for guess comparison
function stripTitleExtras(str: string): string {
    return str
        .replace(/\s*\(feat\.?.*?\)/gi, ' ')
        .replace(/\s*\(ft\.?.*?\)/gi, ' ')
        .replace(/\s*\(with .*?\)/gi, ' ')
        .replace(/\s*\(remix.*?\)/gi, ' ')
        .replace(/\s*\(edit.*?\)/gi, ' ')
        .replace(/\s*\(remaster.*?\)/gi, ' ')
        .replace(/\s*\(live.*?\)/gi, ' ')
        .replace(/\s*\(acoustic.*?\)/gi, ' ')
        .replace(/\s*\([^)]*\)/g, ' ')
        .replace(/\s*\([^)]*$/g, ' ')
        .replace(/\s*\[.*?\]/g, ' ')
        .replace(/\s*-\s*(feat\.?.*|ft\.?.*|with .*|remix|edit|version|mix|live|acoustic|remaster|radio edit|extended mix).*$/gi, ' ')
        .replace(/\s+(?:[a-z0-9]+\s+)?(?:version|remix|edit|mix|live|acoustic|remaster|instrumental|karaoke|cover|demo|extended)\b/gi, ' ')
        // User Request: Remove everything after " - " or "/"
        .replace(/\s+-\s+.*$/g, ' ')
        .replace(/\/.*$/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'for', 'from', 'by', 'with'
])

function removeStopWords(normalized: string): string {
    const tokens = normalized.split(' ').filter(Boolean)
    const filtered = tokens.filter(token => !STOP_WORDS.has(token))
    return filtered.length > 0 ? filtered.join(' ') : normalized
}

function splitArtists(str: string): string[] {
    const cleaned = str
        .replace(/\(.*?\)/g, ' ')
        .replace(/\[.*?\]/g, ' ')
        .replace(/\b(feat|ft|with)\b\.?/gi, ',')
        .replace(/&/g, ',')
        .replace(/\band\b/gi, ',')
        .replace(/\s+/g, ' ')
        .trim()

    return cleaned
        .split(',')
        .map(s => removeStopWords(normalizeForCompare(s)))
        .filter(s => s.length > 0)
}

// --- Tag Extraction ---
const REGEX_VERSION_TAGS = /\(([^)]+)\)|\[([^\]]+)\]|\s-\s(.*)/g
// Keywords that indicate a specific version
const VERSION_KEYWORDS = ['remix', 'live', 'acoustic', 'edit', 'remaster', 'sped up', 'slowed', 'instrumental', 'karaoke', 'cover', 'demo', 'extended', 'mix']

export function extractTags(title: string): string[] {
    const tags: string[] = []
    let match
    // Reset regex state
    REGEX_VERSION_TAGS.lastIndex = 0

    // Simple approach: split by typical delimiters and check keywords
    // The regex above is for capturing groups, but simple checks are safer

    const lowerTitle = title.toLowerCase()

    VERSION_KEYWORDS.forEach(keyword => {
        if (lowerTitle.includes(keyword)) {
            // Ensure it's not part of another word (e.g. "alive" contains "live")
            const regex = new RegExp(`\\b${keyword}\\b`)
            if (regex.test(lowerTitle)) {
                tags.push(keyword)
            }
        }
    })

    return [...new Set(tags)] // Unique
}

// --- Algorithms ---

export function levenshtein(a: string, b: string): number {
    const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i])
    for (let i = 0; i <= a.length; i++) matrix[0][i] = i

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b[i - 1] === a[j - 1]) {
                matrix[i][j] = matrix[i - 1][j - 1]
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                )
            }
        }
    }
    return matrix[b.length][a.length]
}

export function getJaccardSimilarity(a: string, b: string): number {
    const setA = new Set(a.split(' '))
    const setB = new Set(b.split(' '))
    const intersection = new Set([...setA].filter(x => setB.has(x)))
    const union = new Set([...setA, ...setB])
    return union.size === 0 ? 0 : intersection.size / union.size
}

// --- Main Resolver Scorer ---

type TrackCandidate = {
    title: string
    artist: string
    duration: number // in seconds
    rank?: number // popularity
    contributors?: any[] // Deezer contributors (main + featured artists)
}

type TrackSource = {
    title: string
    artist: string
    durationMs?: number
}

export function scoreTrackMatch(source: TrackSource, candidate: TrackCandidate): { score: number, reasons: string[] } {
    let score = 0
    const reasons: string[] = []

    // Extract featured artists from source title (e.g., "song (feat. Artist)" → ["Artist"])
    const extractFeaturedArtists = (title: string): string[] => {
        const features: string[] = []
        const patterns = [
            /\(feat\.?\s+([^)]+)\)/gi, // (feat. Ado)
            /\(with\s+([^)]+)\)/gi,    // (with Ado)
            /\(ft\.?\s+([^)]+)\)/gi,     // (ft. Ado)
            /\s+-\s+feat\.?\s+([^$]+)$/gi, // - feat. Ado
            /\s+feat\.?\s+([^($]+)/gi,     // feat. Ado (at the end)
        ]

        patterns.forEach(pattern => {
            const matches = title.matchAll(pattern)
            for (const match of matches) {
                // Split by & or "and" or "," to handle multiple features
                const artists = match[1].split(/\s+&\s+|\s+and\s+|,\s*/i)
                features.push(...artists.map(a => normalizeForCompare(a.trim())))
            }
        })

        return features
    }

    // Strip featured artists and version info from titles for base comparison
    const stripFeatures = (str: string) => str
        .replace(/\s*\(feat\.?.*?\)/gi, '')
        .replace(/\s*\(with .*?\)/gi, '')
        .replace(/\s*\(ft\.?.*?\)/gi, '')
        .replace(/\s*-\s*.*?(remix|version|edit|mix)/gi, '') // Strip " - ... Remix"
        .trim()

    // IMPORTANT: Strip features BEFORE normalizing (normalizeForCompare removes parentheses)
    const srcTitle = normalizeForCompare(stripFeatures(source.title))
    const candTitle = normalizeForCompare(stripFeatures(candidate.title))
    const srcArtist = normalizeForCompare(source.artist)
    const candArtist = normalizeForCompare(candidate.artist)


    // Extract featured artists from source
    const sourceFeaturedArtists = extractFeaturedArtists(source.title)

    // Get contributor names from Deezer (normalized)
    const contributorNames = new Set([
        ...(candidate.contributors || []).map((c: any) => normalizeForCompare(c.name || '')),
        ...extractFeaturedArtists(candidate.title) // Fallback: extract from title too!
    ])

    if (sourceFeaturedArtists.length > 0) {
    }

    // --- 1. Title Score (Max 40) ---
    if (srcTitle === candTitle) {
        score += 40
        reasons.push("Exact title match")
    } else {
        const jaccard = getJaccardSimilarity(srcTitle, candTitle)
        if (jaccard > 0.8) {
            score += 30
            reasons.push("High title overlap")
        } else if (jaccard > 0.5) {
            score += 10
            reasons.push("Partial title overlap")
        }

        const dist = levenshtein(srcTitle, candTitle)
        if (dist <= 2) {
            score += 15
            reasons.push(`Low levenshtein dist (${dist})`)
        }
    }

    // --- 2. Artist Score (Max 30) ---
    if (srcArtist === candArtist) {
        score += 30
        reasons.push("Exact artist match")
    } else if (srcArtist.includes(candArtist) || candArtist.includes(srcArtist)) {
        score += 20
        reasons.push("Artist substring match")
    } else {
        const dist = levenshtein(srcArtist, candArtist)
        if (dist <= 2) {
            score += 15
            reasons.push("Close artist typo")
        }
    }

    // --- 2.5 Featured Artist Score (Max +15 boost, -20 penalty) ---
    if (sourceFeaturedArtists.length > 0) {
        // Source has featured artists - check if Deezer contributors include them
        let matchedFeatures = 0
        let missingFeatures = 0

        sourceFeaturedArtists.forEach(featured => {
            const found = Array.from(contributorNames).some(contributor =>
                contributor.includes(featured) || featured.includes(contributor)
            )
            if (found) {
                matchedFeatures++
            } else {
                missingFeatures++
            }
        })

        if (matchedFeatures === sourceFeaturedArtists.length) {
            // All featured artists present - perfect match!
            score += 15
            reasons.push(`Featured artists matched: ${sourceFeaturedArtists.join(', ')}`)
        } else if (matchedFeatures > 0) {
            // Some featured artists matched
            score += 5
            reasons.push(`Partial featured match (${matchedFeatures}/${sourceFeaturedArtists.length})`)
        } else {
            // CRITICAL: Source HAS features, Candidate matched NONE of them.
            // If the candidate HAS contributors/features, but they don't match Ado, this is likely a wrong version.
            if (contributorNames.size > 0) {
                score -= 40 // Heavy penalty for matching the WRONG features
                reasons.push("Wrong featured artists entirely")
            }
        }
    } else if (contributorNames.size > 1) {
        // Source has NO featured artists, but Deezer has multiple contributors
        // This might be a featured version when we want the clean one
        // Small penalty to prefer non-featured versions
        score -= 5
        reasons.push("Candidate has extra contributors (may be featured version)")
    }

    // --- 3. Version / Tags Check ---
    const sourceTags = extractTags(source.title)
    const candTags = extractTags(candidate.title)
    const hasSourceTags = sourceTags.length > 0
    const hasCandTags = candTags.length > 0

    // Check strict version mismatch
    if (!hasSourceTags && hasCandTags) {
        // Source is generic, Candidate is "Remix" -> Penalty
        score -= 35
        reasons.push(`Unexpected version tags: ${candTags.join(',')}`)
    } else if (hasSourceTags) {
        // Source IS a specific version, Candidate MUST match at least one
        const overlap = sourceTags.filter(t => candTags.includes(t))
        if (overlap.length > 0) {
            score += 15
            reasons.push(`Version matched: ${overlap.join(',')}`)
        } else {
            score -= 20
            reasons.push("Missing required version tag")
        }
    }

    // --- 4. Duration Check (Max 25) ---
    if (source.durationMs) {
        const sourceSec = source.durationMs / 1000
        const diff = Math.abs(sourceSec - candidate.duration)

        if (diff <= 2) {
            score += 25
            reasons.push("Duration matches exactly")
        } else if (diff <= 5) {
            score += 15
            reasons.push("Duration matches roughly")
        } else if (diff > 15) {
            score -= 30
            reasons.push(`Duration mismatch (${Math.round(diff)}s diff)`)
        }
    }

    // --- 5. Popularity Tie-Breaker ---
    if (candidate.rank && candidate.rank > 500000) {
        score += 5
        reasons.push("High popularity")
    }

    return { score, reasons }
}


// --- Legacy Game Matcher (User Guesses) ---
export function isMatch(guess: string, answer: string, isArtist: boolean = false): boolean {
    if (!guess || !answer) return false
    const trimmedGuess = guess.trim()
    if (!trimmedGuess) return false
    const trimmedAnswer = answer.trim()
    if (!trimmedAnswer) return false

    // Use new cleaner normalization for better guessing too
    const normGuess = removeStopWords(normalizeForCompare(isArtist ? trimmedGuess : stripTitleExtras(trimmedGuess)))
    const normAnswer = removeStopWords(normalizeForCompare(isArtist ? trimmedAnswer : stripTitleExtras(trimmedAnswer)))

    if (isArtist) {
        // Split comma separated artists
        const answerArtists = splitArtists(answer)
        const match = answerArtists.some(artist => {
            if (artist === normGuess) return true
            if (artist.includes(normGuess) && normGuess.length > 3) return true
            if (normGuess.includes(artist) && artist.length > 3) return true
            if (levenshtein(normGuess, artist) <= 1) return true
            return false
        })
        return match
    }

    // Songs
    let match = false
    if (normGuess === normAnswer) match = true
    else if (normGuess.includes(normAnswer) && normGuess.length <= normAnswer.length + 2) match = true
    else if (normAnswer.includes(normGuess) && normGuess.length >= normAnswer.length - 2) match = true
    else if (levenshtein(normGuess, normAnswer) <= 1) match = true

    return match
}

export function calculateScore(
    guess: { artist: string, title: string },
    answer: { artist: string, title: string },
    timeLeft: number,
    totalTime: number,
    mode: ScoringMode,
    isSuddenDeath: boolean = false
): { points: number, correctTitle: boolean, correctArtist: boolean } {

    let points = 0
    const correctTitle = isMatch(guess.title, answer.title, false)
    const correctArtist = isMatch(guess.artist, answer.artist, true)


    // Base Points
    const TITLE_POINTS = 5
    const ARTIST_POINTS = 2

    // Multipliers
    let timeMultiplier = 1
    if (mode === 'rapid') {
        timeMultiplier = 1 + (timeLeft / totalTime)
    }

    if (isSuddenDeath) {
        // Sudden Death: 1 point per correct field (respect mode if artist/song only)
        if (mode === 'artist_only') {
            if (correctArtist) points += 1
        } else if (mode === 'song_only') {
            if (correctTitle) points += 1
        } else {
            if (correctTitle) points += 1
            if (correctArtist) points += 1
        }
    } else if (mode === 'artist_only') {
        if (correctArtist) points += 1
    } else if (mode === 'song_only') {
        if (correctTitle) points += 1
    } else if (mode === 'lyrics_only') {
        if (correctTitle) points += ARTIST_POINTS
        if (correctArtist) points += TITLE_POINTS
    } else {
        // Normal
        if (correctTitle) points += TITLE_POINTS * timeMultiplier
        if (correctArtist) points += ARTIST_POINTS * timeMultiplier
    }

    return {
        points: Math.round(points),
        correctTitle,
        correctArtist
    }
}
