export type ScoringMode = 'normal' | 'rapid' | 'artist_only' | 'song_only' | 'lyrics_only'

// Normalize strings for comparison (remove punctuation, parentheticals, lowercase)
export function normalize(str: string): string {
    return str
        .toLowerCase()
        // Remove parentheticals: (feat. ...), (Remix), (Live), etc.
        .replace(/\([^)]*\)/g, '')
        // Remove brackets: [...]
        .replace(/\[[^\]]*\]/g, '')
        // Remove special chars except spaces
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

// Simple Levenshtein distance for fuzzy match
function levenshtein(a: string, b: string): number {
    const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i])
    for (let i = 0; i <= a.length; i++) matrix[0][i] = i

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b[i - 1] === a[j - 1]) {
                matrix[i][j] = matrix[i - 1][j - 1]
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                )
            }
        }
    }
    return matrix[b.length][a.length]
}

export function isMatch(guess: string, answer: string, isArtist: boolean = false): boolean {
    if (!guess || !answer) return false
    const normGuess = normalize(guess)
    const normAnswer = normalize(answer)

    if (isArtist) {
        // For artists: support partial matching with comma-separated names
        const answerArtists = normAnswer.split(/[,&]/).map(a => a.trim()).filter(a => a.length > 0)

        // Check if guess matches any of the artists
        return answerArtists.some(artist => {
            if (artist === normGuess) return true
            if (artist.includes(normGuess) && normGuess.length > 3) return true
            if (normGuess.includes(artist) && artist.length > 3) return true
            return false
        })
    }

    // For songs: exact match with some flexibility
    if (normGuess === normAnswer) return true
    if (normGuess.includes(normAnswer) && normGuess.length <= normAnswer.length + 2) return true
    if (normAnswer.includes(normGuess) && normGuess.length >= normAnswer.length - 2) return true

    // Stricter typo allowance - first letter must match
    if (normGuess[0] !== normAnswer[0]) return false

    // Allow only 1 char typo for longer words
    const distance = levenshtein(normGuess, normAnswer)
    if (normAnswer.length > 6 && distance <= 1) return true

    return false
}

export function calculateScore(
    guess: { artist: string, title: string },
    answer: { artist: string, title: string },
    timeLeft: number,
    totalTime: number,
    mode: ScoringMode
): { points: number, correctTitle: boolean, correctArtist: boolean } {

    let points = 0
    const correctTitle = isMatch(guess.title, answer.title, false) // false = song title
    const correctArtist = isMatch(guess.artist, answer.artist, true) // true = artist

    // Base Points
    const TITLE_POINTS = 5
    const ARTIST_POINTS = 2

    // Multipliers
    let timeMultiplier = 1
    if (mode === 'rapid') {
        // Linear decay from 2x to 1x
        timeMultiplier = 1 + (timeLeft / totalTime)
    }

    if (mode === 'artist_only') {
        // Single-field modes are binary: correct = 1 point
        if (correctArtist) points += 1
    } else if (mode === 'song_only') {
        if (correctTitle) points += 1
    } else if (mode === 'lyrics_only') {
        // Lyrics mode uses full guessing (title + artist)
        if (correctTitle) points += TITLE_POINTS
        if (correctArtist) points += ARTIST_POINTS
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
