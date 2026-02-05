
// Mock logic from scoring.ts to reproduce the issue
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
        // DEBUG LOG
        console.log(`[isMatch] Guess: "${guess}" -> "${normGuess}"`)
        console.log(`[isMatch] Answer: "${answer}" -> Split: ${JSON.stringify(answerArtists)}`)

        return answerArtists.some(artist => {
            if (artist === normGuess) return true
            if (artist.includes(normGuess) && normGuess.length > 3) return true
            if (normGuess.includes(artist) && artist.length > 3) return true
            if (levenshtein(normGuess, artist) <= 1) return true
            return false
        })
    }

    // Song logic
    if (normGuess === normAnswer) return true
    if (normGuess.includes(normAnswer) && normGuess.length <= normAnswer.length + 2) return true
    if (normAnswer.includes(normGuess) && normGuess.length >= normAnswer.length - 2) return true
    if (levenshtein(normGuess, normAnswer) <= 1) return true
    return false
}

// Reproduction
console.log('--- Reproduction Test ---')
const guess = 'kendrick lamar'
const answer = 'Kendrick Lamar'
const match = isMatch(guess, answer, true)
console.log(`Match Result: ${match}`)

console.log('--- Edge Case Test ---')
console.log(`Match 'Kendrick': ${isMatch('Kendrick', answer, true)}`)
console.log(`Match 'kendrick': ${isMatch('kendrick', answer, true)}`)

console.log('--- With Feat Test ---')
const answer2 = 'Kendrick Lamar & SZA'
console.log(`Answer: "${answer2}"`)
console.log(`Match 'Kendrick Lamar': ${isMatch('Kendrick Lamar', answer2, true)}`)
console.log(`Match 'SZA': ${isMatch('SZA', answer2, true)}`)
