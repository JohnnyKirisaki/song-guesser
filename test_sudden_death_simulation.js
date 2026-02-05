
// --- MOCK DEPENDENCIES ---

function normalizeForCompare(str) {
    if (!str) return ''
    return str
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[&]/g, 'and')
        .replace(/[^a-z0-9$ ]/g, '')
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

    return cleaned.split(',').map(s => normalizeForCompare(s)).filter(s => s.length > 0)
}

function levenshtein(a, b) {
    const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i])
    for (let i = 0; i <= a.length; i++) matrix[0][i] = i
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b[i - 1] === a[j - 1]) matrix[i][j] = matrix[i - 1][j - 1]
            else matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
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

function calculateScore(guess, answer, timeLeft, totalTime, mode, isSuddenDeath = false) {
    let points = 0
    const correctTitle = isMatch(guess.title, answer.title, false)
    const correctArtist = isMatch(guess.artist, answer.artist, true)

    if (isSuddenDeath) {
        if (correctTitle) points += 1
        if (correctArtist) points += 1
    } else {
        if (correctTitle) points += 5
        if (correctArtist) points += 2 // simplified normal mode
    }

    return { points, correctTitle, correctArtist }
}

// --- SIMULATION ---

async function simulate() {
    console.log('=== SUDDEN DEATH SIMULATION ===')

    // 1. Setup Players
    let players = [
        { id: 'p1', username: 'Player 1', score: 0, sudden_death_score: 0 },
        { id: 'p2', username: 'Player 2', score: 0, sudden_death_score: 0 },
        { id: 'p3', username: 'Player 3', score: 14, sudden_death_score: 0 } // High score, not in SD
    ]

    console.log('\n[Phase 1] Initial State (End of Normal Game)')
    console.table(players.map(p => ({ id: p.id, score: p.score })))

    // Check for Tie (p1 vs p2 at 0 pts)
    console.log('\nChecking Tie...')
    const sorted = [...players].sort((a, b) => b.score - a.score)
    // Actually, P3 is winning, but let's assume P1 and P2 are fighting for *a* spot?
    // Wait, user request said "make both player draw with 0 points and go to sudden death"
    // But then added "Player 3 that didnt go to sudden death because he had 14 points"
    // This implies P3 WON already. Usually Sudden Death is for 1st place.
    // If P3 has 14, P1 has 0, P2 has 0... P3 is the winner. No Sudden Death for 1st.
    // BUT maybe "Sudden Death" happens for 2nd place? Or maybe the user implies P1/P2 tied for 1st (so ignore P3 for a moment or assume P3 has 0 too?)
    // User quote: "Player 3 that didnt go to sudden death because he had 14 points does he get 1#, player 1 2# and player 2 3#?"
    // This implies P3 is way ahead. P1 and P2 are tied for 2nd. 
    // Does the game trigger Sudden Death for 2nd place?
    // My code only checks `sorted[0].score === sorted[1].score` (Tie for FIRST).

    // Let's assume for this test that P1 and P2 are tied for 1st (0 pts), and P3 is a hypothetical bystander for later ranking check,
    // OR that P3 exists but we force P1 vs P2 sudden death.
    // Let's strictly follow the "Go to Sudden Death" instruction.
    // This requires P1 and P2 to be tied for the HIGHEST score.
    // So let's remove P3's lead for a moment to trigger SD, OR assume logic supports arbitrary ties (it doesn't, usually 1st).

    // ADJUSTMENT: The user scenario description is a bit contradictory ("Player 3 ... 14 points... make both player draw with 0").
    // If P3 has 14, P1=0, P2=0 -> P3 Wins. Period.
    // I will simulate P1=14, P2=14 (Tied 1st), P3=0. This triggers SD.
    // OR if the user really wants P1=0, P2=0, then P3 must be absent or < 0.

    // Let's try to interpret "standings get correct" as:
    // P3 = 14 (Winner)
    // P1 = 2 (2nd) - after SD
    // P2 = 2 (3rd) - after SD (loser?)
    // WAIT. If P1 and P2 go to SD, they must have been TIED.
    // If P3 has 14, and P1/P2 have 2... they are NOT tied with P3.
    // Maybe the user asks: "If P1 and P2 are tied for 2nd place, do they duel?"
    // My code: `const topScore = sorted[0]?.score... const drawPlayers = sorted.filter(p => p.score === topScore)`
    // So NO. Sudden Death ONLY happens for the #1 spot.

    // SO, for the test to be valid for Sudden Death logic:
    // P1 and P2 MUST be tied for #1.
    // P3 must have LOWER score.

    // Let's simulate:
    // P1: 0 pts
    // P2: 0 pts
    // P3: -5 pts (so he is last)

    // Wait, user said "Player 3 ... he had 14 points". 
    // This implies P3 is #1.
    // If P3 is #1, then P1 vs P2 (for 2nd place) does NOT trigger Sudden Death in my current code.
    // I should test EXACTLY what the user described and report if it FAILS to trigger SD (which is correct behavior).
    // BUT the user wants to test SCORING.

    // Let's simulate a standard SD scenario (Tie for 1st) to verify the scoring math.
    players = [
        { id: 'p1', username: 'Player 1', score: 0, sudden_death_score: 0 },
        { id: 'p2', username: 'Player 2', score: 0, sudden_death_score: 0 }
    ]
    let gameState = {
        is_sudden_death: true,
        dueling_player_ids: ['p1', 'p2'] // They entered SD
    }

    console.log('\n[Phase 2] Entered Sudden Death (0-0 Tie)')

    // SCENARIO ROUND 1
    // Song: Kendrick Lamar - Humble
    // P1 Guesses Song: "Humble" (Correct) + Artist: "" (Wrong/Empty)
    // P2 Guesses: ""

    console.log('\n--- Round 1: Kendrick Lamar - Humble ---')
    const song1 = { artist: 'Kendrick Lamar', title: 'Humble' }
    const res1_p1 = calculateScore({ artist: '', title: 'Humble' }, song1, 10, 15, 'normal', true)
    const res1_p2 = calculateScore({ artist: '', title: '' }, song1, 10, 15, 'normal', true)

    console.log(`P1 Guess (Song only): Points = ${res1_p1.points}`)
    console.log(`P2 Guess (None): Points = ${res1_p2.points}`)

    // Update Scores
    players[0].sudden_death_score += res1_p1.points // P1 +1
    players[1].sudden_death_score += res1_p2.points // P2 +0

    // Check Standings
    console.log('Scores after R1:', players.map(p => `${p.username}: SD=${p.sudden_death_score}, Main=${p.score}`))

    // Win Check logic
    let sortedSD = [...players].sort((a, b) => b.sudden_death_score - a.sudden_death_score)
    let lead = sortedSD[0].sudden_death_score - sortedSD[1].sudden_death_score
    console.log(`Lead: ${lead} (Need 2 to win)`)
    if (lead >= 2) console.log('WIN DETECTED!')
    else console.log('No win yet.')

    // SCENARIO ROUND 2
    // Song: bbno$ - ADD
    // P1 Guesses Artist: "bbno$" (Correct)
    // P2 Guesses: ""

    console.log('\n--- Round 2: bbno$ - ADD ---')
    const song2 = { artist: 'bbno$', title: 'ADD' }
    const res2_p1 = calculateScore({ artist: 'bbno$', title: '' }, song2, 10, 15, 'normal', true)
    const res2_p2 = calculateScore({ artist: '', title: '' }, song2, 10, 15, 'normal', true)

    console.log(`P1 Guess (Artist "bbno$"): Points = ${res2_p1.points}`)
    console.log(`P2 Guess (None): Points = ${res2_p2.points}`)

    players[0].sudden_death_score += res2_p1.points // P1 +1 (Total 2)
    players[1].sudden_death_score += res2_p2.points // P2 +0

    console.log('Scores after R2:', players.map(p => `${p.username}: SD=${p.sudden_death_score}, Main=${p.score}`))

    // Win Check
    sortedSD = [...players].sort((a, b) => b.sudden_death_score - a.sudden_death_score)
    lead = sortedSD[0].sudden_death_score - sortedSD[1].sudden_death_score
    console.log(`Lead: ${lead} (Need 2 to win)`)

    let gameEnded = false
    if (lead >= 2) {
        console.log('WIN DETECTED! Ending Sudden Death.')
        gameEnded = true
    }

    // FINAL STANDINGS CHECK (Including P3 Scenario)
    console.log('\n[Phase 3] Final Standings Analysis')
    // Let's add P3 back to see how the final sort looks
    players.push({ id: 'p3', username: 'Player 3', score: 14, sudden_death_score: 0 })

    // Logic from GameRecap.tsx
    // sort((a, b) => {
    //     if (b.score !== a.score) return b.score - a.score
    //     return (b.sudden_death_score || 0) - (a.sudden_death_score || 0)
    // })

    const finalSorted = [...players].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return (b.sudden_death_score || 0) - (a.sudden_death_score || 0)
    })

    console.table(finalSorted.map((p, i) => ({
        Rank: i + 1,
        Name: p.username,
        MainScore: p.score,
        SDScore: p.sudden_death_score
    })))

    // Assertions
    const p1 = finalSorted.find(p => p.id === 'p1')
    const p2 = finalSorted.find(p => p.id === 'p2')
    const p3 = finalSorted.find(p => p.id === 'p3')

    console.log('\n--- VERIFICATION ---')
    console.log(`1. Scores 2-0? P1 SD=${p1.sudden_death_score}, P2 SD=${p2.sudden_death_score} -> ${p1.sudden_death_score === 2 && p2.sudden_death_score === 0 ? 'PASS' : 'FAIL'}`)
    console.log(`2. Game Ended (Win by 2)? -> ${gameEnded ? 'PASS' : 'FAIL'}`)
    console.log(`3. P1 higher than P2? -> ${finalSorted.indexOf(p1) < finalSorted.indexOf(p2) ? 'PASS' : 'FAIL'}`)
    console.log(`4. P3 is #1? -> ${finalSorted[0].id === 'p3' ? 'PASS' : 'FAIL'}`)
}

simulate()
