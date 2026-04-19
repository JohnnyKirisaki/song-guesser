export type ScoringMode = 'normal' | 'rapid' | 'artist_only' | 'song_only' | 'lyrics_only' | 'album_art' | 'guess_who' | 'who_sang_that' | 'chill_rating' | 'year_guesser' | 'mixed' | 'buzzer' | 'lyric_completion' | 'emoji_charades' | 'snippet_reveal'

/**
 * Year-guesser scoring table. Graduated by absolute distance in years:
 *   0 (exact):     3 points
 *   ±1 year:       2 points
 *   ±2 years:      1 point
 *   anything else: 0 points
 * Exposed so the reveal route can share the same rubric the client shows.
 */
export function scoreYearGuess(guessYear: number | null | undefined, answerYear: number | null | undefined): { points: number; diff: number | null } {
    if (
        guessYear == null ||
        answerYear == null ||
        !Number.isFinite(guessYear) ||
        !Number.isFinite(answerYear)
    ) {
        return { points: 0, diff: null }
    }
    const diff = Math.abs(Math.round(guessYear) - Math.round(answerYear))
    if (diff === 0) return { points: 3, diff }
    if (diff === 1) return { points: 2, diff }
    if (diff === 2) return { points: 1, diff }
    return { points: 0, diff }
}

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
        .replace(/\s*-\s*(deluxe|expanded|complete|platinum|special|collector'?s?|anniversary|bonus|tour|edition|version).*$/gi, ' ')
        .replace(/\s*-\s*(feat\.?.*|ft\.?.*|with .*|remix|edit|version|mix|live|acoustic|remaster|radio edit|extended mix).*$/gi, ' ')
        .replace(/\s+(?:[a-z0-9]+\s+)?(?:version|remix|edit|mix|live|acoustic|remaster|instrumental|karaoke|cover|demo|extended|deluxe|expanded|complete|platinum|special|collector'?s?|anniversary|bonus|edition)\b/gi, ' ')
        // User Request: Remove everything after " - " or "/"
        .replace(/\s+-\s+.*$/g, ' ')
        .replace(/\/.*$/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'for', 'from', 'by', 'with',
    // Portuguese
    'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas',
    'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'em', 'de', 'para', 'por', 'com', 'sem', 'sob'
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
    // Check strict version mismatch
    if (!hasSourceTags && hasCandTags) {
        // Source is generic, Candidate is "Remix" -> Penalty
        // Reduced from -35 to -20 to allow remixes if they are the only option
        // (Score 70 - 20 = 50 > 40 threshold)
        score -= 20
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
        // 1. Check full answer match (for groups like "Florence + The Machine")
        // Use Jaccard for "bag of words" match (handles order/missing stop words)
        // Threshold 0.75 ensures "Harry" (0.5) doesn't match "Harry Styles", but "Florence The Machine" (0.75+) matches
        if (getJaccardSimilarity(normGuess, normAnswer) >= 0.75) return true
        if (levenshtein(normGuess, normAnswer) <= 1) return true

        // 2. Check individual artists (for "Timbaland & OneRepublic")
        const answerArtists = splitArtists(answer)
        return answerArtists.some(artist => {
            // Strict match for individual artists too
            if (getJaccardSimilarity(normGuess, artist) >= 0.75) return true
            if (levenshtein(normGuess, artist) <= 1) return true
            return false
        })
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
    guess: { artist: string, title: string, snippet_used?: number },
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
    } else if (mode === 'album_art') {
        // Album Art: title field = album name (4 base pts), artist field = artist (1 base pt)
        // Time bonus applied per field independently
        const timeMult = 1 + (timeLeft / totalTime)
        if (correctTitle) points += 4 * timeMult  // album correct
        if (correctArtist) points += 1 * timeMult // artist correct
    } else if (mode === 'chill_rating') {
        // Chill Rating: no scoring. Reveal route handles ratings separately.
        points = 0
    } else if (mode === 'guess_who' || mode === 'who_sang_that') {
        // Social modes: 1 point if correct. Reveal route calls this with a boolean in correctTitle.
        if (correctTitle) points += 1
    } else if (mode === 'year_guesser') {
        // Year Guesser: guess.title carries the numeric year (UI uses a number
        // input but we serialize everything through the `title` field for
        // compatibility with existing Firebase schema). Reveal route does the
        // authoritative scoring via scoreYearGuess(); this branch is defensive.
        const guessYear = parseInt(guess?.title || '', 10)
        const answerYear = parseInt(answer?.title || '', 10)
        const { points: p, diff } = scoreYearGuess(guessYear, answerYear)
        points = p
        // Surface "exact hit" in correctTitle so the reveal UI can render a
        // green glow consistently with other modes.
        return { points, correctTitle: diff === 0, correctArtist: false }
    } else if (mode === 'buzzer') {
        // Buzzer: high-risk single-shot. Points scale steeply with time left
        // (early correct = big; late correct = small). Wrong = 0. Artist
        // optionally adds a smaller bonus.
        const aggressiveMult = 1 + 2 * (timeLeft / Math.max(totalTime, 1))
        if (correctTitle) points += TITLE_POINTS * aggressiveMult
        if (correctArtist) points += ARTIST_POINTS * aggressiveMult
    } else if (mode === 'lyric_completion') {
        // Lyric Completion: the challenge lyric line comes via answer.title,
        // the player's typed next-line via guess.title. Fuzzy-match for
        // typos/punctuation.
        const ok = isMatch(guess?.title || '', answer?.title || '', false)
        if (ok) points += 3 * (1 + 0.5 * (timeLeft / Math.max(totalTime, 1)))
        return { points: Math.round(points), correctTitle: ok, correctArtist: false }
    } else if (mode === 'emoji_charades') {
        // Emoji Charades: emojis in prompt, guess is the track title. Same
        // scoring shape as song_only.
        if (correctTitle) points += 3 * (1 + 0.5 * (timeLeft / Math.max(totalTime, 1)))
    } else if (mode === 'snippet_reveal') {
        // Snippet Reveal: rounds run on consensus votes, not a clock, so the
        // multiplier is driven by HOW MUCH of the clip was unlocked when the
        // player submitted — 1s = full points, decays ~10% per extra second,
        // floor at 0.2x so a full-reveal correct guess still pays something.
        const sc = typeof guess.snippet_used === 'number' && guess.snippet_used >= 1
            ? guess.snippet_used
            : 30
        const mult = Math.max(0.2, 1 - (sc - 1) * 0.1)
        if (correctTitle) points += TITLE_POINTS * mult
        if (correctArtist) points += ARTIST_POINTS * mult
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
