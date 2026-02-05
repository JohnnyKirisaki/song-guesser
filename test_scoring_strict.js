
// --- Helper Functions (Copied from scoring.ts) ---

function normalizeForCompare(str) {
    if (!str) return ''
    return str
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove accents
        .replace(/[&]/g, 'and')
        .replace(/[^a-z0-9$ ]/g, '') // Keep $ and alphanumeric
        .replace(/\s+/g, ' ')
        .trim()
}

function stripTitleExtras(str) {
    return str
        .replace(/\s*\(feat\.?.*?\)/gi, ' ')
        .replace(/\s*\(ft\.?.*?\)/gi, ' ')
        .replace(/\s*\(with .*?\)/gi, ' ')
        .replace(/\s*\(remix.*?\)/gi, ' ')
        .replace(/\s*\(edit.*?\)/gi, ' ')
        .replace(/\s*\(remaster.*?\)/gi, ' ')
        .replace(/\s*\(live.*?\)/gi, ' ')
        .replace(/\s*\(acoustic.*?\)/gi, ' ')
        .replace(/\s*\[.*?\]/g, ' ')
        .replace(/\s*-\s*(feat\.?.*|ft\.?.*|with .*|remix|edit|version|mix|live|acoustic|remaster|radio edit|extended mix).*$/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function splitArtists(str) {
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
        .map(s => normalizeForCompare(s))
        .filter(s => s.length > 0)
}

function levenshtein(a, b) {
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

function isMatch(guess, answer, isArtist = false) {
    if (!guess || !answer) return false
    const normGuess = normalizeForCompare(isArtist ? guess : stripTitleExtras(guess))
    const normAnswer = normalizeForCompare(isArtist ? answer : stripTitleExtras(answer))

    if (isArtist) {
        const answerArtists = splitArtists(answer)
        const match = answerArtists.some(artist => {
            if (artist === normGuess) return true
            if (artist.includes(normGuess) && normGuess.length > 3) return true
            if (normGuess.includes(artist) && artist.length > 3) return true
            if (levenshtein(normGuess, artist) <= 1) return true
            return false
        })
        console.log(`[isMatch] Artist: "${guess}" vs "${answer}" -> Match: ${match}`)
        return match
    }

    let match = false
    if (normGuess === normAnswer) match = true
    else if (normGuess.includes(normAnswer) && normGuess.length <= normAnswer.length + 2) match = true
    else if (normAnswer.includes(normGuess) && normGuess.length >= normAnswer.length - 2) match = true
    else if (levenshtein(normGuess, normAnswer) <= 1) match = true

    console.log(`[isMatch] Song: "${guess}" vs "${answer}" -> Match: ${match}`)
    return match
}


function calculateScore(
    guess,
    answer,
    timeLeft,
    totalTime,
    mode,
    isSuddenDeath = false
) {
    let points = 0
    const correctTitle = isMatch(guess.title, answer.title, false)
    const correctArtist = isMatch(guess.artist, answer.artist, true)

    console.log(`[calculateScore] Mode: ${mode}, SuddenDeath: ${isSuddenDeath}`)

    const TITLE_POINTS = 5
    const ARTIST_POINTS = 2

    let timeMultiplier = 1
    if (mode === 'rapid') {
        timeMultiplier = 1 + (timeLeft / totalTime)
    }

    if (isSuddenDeath) {
        if (correctTitle) points += 1
        if (correctArtist) points += 1
    } else if (mode === 'artist_only') {
        if (correctArtist) points += 1
    } else if (mode === 'song_only') {
        if (correctTitle) points += 1
    } else if (mode === 'lyrics_only') {
        if (correctTitle) points += TITLE_POINTS
        if (correctArtist) points += ARTIST_POINTS
    } else {
        if (correctTitle) points += TITLE_POINTS * timeMultiplier
        if (correctArtist) points += ARTIST_POINTS * timeMultiplier
    }

    return {
        points: Math.round(points),
        correctTitle,
        correctArtist
    }
}

// --- TEST SUITE ---

console.log('=== STARTING TEST SUITE ===')

const guess = { artist: 'kendrick lamar', title: 'alright' }
const answer = { artist: 'Kendrick Lamar', title: 'Alright' }

console.log('\n--- TEST 1: Sudden Death (Should be 2 points) ---')
const result1 = calculateScore(guess, answer, 10, 15, 'normal', true)
console.log('Result:', result1)
if (result1.points !== 2) console.error('FAIL: Expected 2 points in Sudden Death')
else console.log('PASS')

console.log('\n--- TEST 2: Normal Mode (Should be 7+ points) ---')
const result2 = calculateScore(guess, answer, 10, 15, 'normal', false)
console.log('Result:', result2)
if (result2.points < 7) console.error('FAIL: Expected standard points in Normal Mode')
else console.log('PASS')

console.log('\n--- TEST 3: Partial Match (Artist Only) in Sudden Death ---')
const guessPartial = { artist: 'kendrick lamar', title: '' }
const result3 = calculateScore(guessPartial, answer, 10, 15, 'normal', true)
console.log('Result:', result3)
if (result3.points !== 1) console.error('FAIL: Expected 1 point for Artist Only')
else console.log('PASS')

console.log('\n=== TEST SUITE COMPLETE ===')
