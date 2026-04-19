/**
 * Helpers for new-mode extras generation:
 *  - lyric_completion: pick two consecutive lyric lines from a song's lyrics.
 *    Prompt = first line (shown to players), answer = second line (what they type).
 *  - emoji_charades: convert a track title to an emoji string via a word
 *    dictionary; falls back to music emoji when no token maps cleanly.
 *
 * Both helpers are deterministic given the same inputs so we can cache the
 * extras under `{mode}_extras/{songId}` and replay safely on resume.
 */

export type LyricCompletionExtra = {
    challenge: string  // line shown to the player
    answer: string     // line the player must type (fuzzy-matched)
}

/**
 * Splits lyrics into non-trivial lines and picks a challenge/answer pair from
 * the middle third of the song (avoids intros/outros that often have
 * repetitive "oh oh oh" filler). Returns null if no usable pair exists.
 */
export function pickLyricCompletionPair(lyrics: string | null | undefined): LyricCompletionExtra | null {
    if (typeof lyrics !== 'string' || lyrics.length < 50) return null

    const rawLines = lyrics
        .split(/\r?\n/)
        .map(l => l.replace(/\[[^\]]+\]/g, '').trim())  // strip [Chorus], [Verse 1], etc
        .filter(l => l.length >= 8 && l.length <= 140)

    if (rawLines.length < 4) return null

    // Filter out very repetitive or gibberish lines (oohs, yeahs)
    const useful = rawLines.filter(line => {
        const words = line.split(/\s+/).filter(Boolean)
        if (words.length < 3) return false
        const unique = new Set(words.map(w => w.toLowerCase()))
        // Reject lines where <40% of the words are unique (e.g. "oh oh oh oh")
        if (unique.size / words.length < 0.4) return false
        return true
    })
    if (useful.length < 4) return null

    // Prefer middle-third lines for meaty chorus/verse content
    const start = Math.floor(useful.length / 3)
    const end = Math.floor((useful.length * 2) / 3)
    const window = useful.slice(start, Math.max(end, start + 2))

    // Pick a pair of consecutive lines deterministically from this window
    const idx = Math.floor(window.length / 2)
    const challenge = window[idx - 1] ?? window[0]
    const answer = window[idx] ?? window[1]

    if (!challenge || !answer || challenge === answer) return null
    return { challenge, answer }
}

// --- Emoji Charades ---

// Small hand-curated dictionary. Keep it short and obvious — obscure mappings
// just frustrate players. Words are checked as whole-token lowercase matches.
const EMOJI_WORDS: Record<string, string> = {
    love: '❤️', heart: '❤️', heartbreak: '💔', broken: '💔',
    fire: '🔥', burn: '🔥', hot: '🔥', blazing: '🔥',
    night: '🌙', moon: '🌙', midnight: '🌙', dark: '🌑',
    sun: '☀️', sunshine: '☀️', summer: '☀️',
    rain: '🌧️', storm: '⛈️', thunder: '⚡', lightning: '⚡',
    sky: '☁️', cloud: '☁️', clouds: '☁️',
    star: '⭐', starry: '✨',
    dance: '💃', dancing: '💃', danced: '💃', dancer: '💃',
    party: '🎉', celebration: '🎉', celebrate: '🎉',
    music: '🎵', song: '🎶', songs: '🎶', melody: '🎼',
    kiss: '💋', kisses: '💋', kissed: '💋',
    tears: '😢', cry: '😢', crying: '😭', sad: '😢',
    smile: '😊', happy: '😊', happiness: '😊',
    devil: '😈', hell: '🔥',
    money: '💰', cash: '💵', rich: '💎', diamond: '💎', diamonds: '💎',
    king: '👑', queen: '👑', crown: '👑',
    gun: '🔫', shoot: '🔫', shot: '🔫',
    car: '🚗', drive: '🚗', driving: '🚗', road: '🛣️',
    run: '🏃', running: '🏃', away: '🏃',
    time: '⏰', clock: '🕐', hours: '⏰',
    eye: '👁️', eyes: '👀', see: '👀', blind: '🙈',
    head: '🧠', mind: '🧠', brain: '🧠', crazy: '🤪',
    home: '🏠', house: '🏠',
    ocean: '🌊', sea: '🌊', wave: '🌊', waves: '🌊', water: '💧',
    world: '🌍', earth: '🌍', global: '🌍',
    dream: '💭', dreams: '💭', dreaming: '💭',
    sick: '🤒', dead: '💀', die: '💀', dying: '💀', death: '💀',
    girl: '👧', girls: '👯', boy: '👦', boys: '👬',
    baby: '👶', darling: '🥰', honey: '🍯',
    wine: '🍷', drunk: '🍸', drink: '🍺', beer: '🍺',
    gold: '🥇', silver: '🥈',
    space: '🚀', rocket: '🚀', stars: '✨', galaxy: '🌌',
    flower: '🌹', rose: '🌹', flowers: '💐',
    gone: '👋', goodbye: '👋', hello: '👋',
    yes: '✅', no: '❌',
    bad: '👎', good: '👍', great: '👍',
    high: '⬆️', low: '⬇️', up: '⬆️', down: '⬇️',
    you: '🫵', me: '👤', us: '👥', them: '👥',
    free: '🕊️', freedom: '🕊️', bird: '🐦',
    phone: '📱', call: '📞', text: '💬',
    truth: '💯', lie: '🤥', liar: '🤥',
    sweet: '🍭', sugar: '🍭', candy: '🍬',
    cake: '🍰', birthday: '🎂',
    angel: '😇', god: '🙏', heaven: '☁️',
    blood: '🩸', red: '🔴', blue: '🔵', green: '🟢', black: '⬛', white: '⬜'
}

/**
 * Converts a song title into an emoji representation for emoji_charades mode
 * using the local word dictionary. Always returns a non-empty string — falls
 * back to 🎵🎶🎵 for titles where no word matches (so the UI never renders
 * empty). Kept as a synchronous fallback for `generateEmojiPuzzle` below when
 * the Gemini API is unavailable.
 */
export function titleToEmoji(title: string | null | undefined): string {
    if (typeof title !== 'string' || title.length === 0) return '🎵🎶🎵'

    // Strip parens content and feat. clauses — they hurt recognition
    const cleaned = title
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\bfeat\.?\b.*/i, '')
        .replace(/\bft\.?\b.*/i, '')
        .replace(/[^\w\s'-]/g, ' ')

    const words = cleaned
        .split(/\s+/)
        .map(w => w.toLowerCase().replace(/[^a-z]/g, ''))
        .filter(Boolean)

    const emojis: string[] = []
    for (const word of words) {
        const e = EMOJI_WORDS[word]
        if (e) emojis.push(e)
    }

    if (emojis.length === 0) return '🎵🎶🎵'
    // Cap at 8 emojis — longer strings become harder to parse visually
    return emojis.slice(0, 8).join(' ')
}

// Emoji-only validator: Unicode property escapes let us keep only actual
// emoji codepoints (plus ZWJ + variation selector for compound emoji like
// ❤️ and 👨‍👩‍👧). Guards against the model returning stray letters.
function stripNonEmoji(s: string): string {
    // \p{Extended_Pictographic} covers the base emoji set; the rest are
    // joiners/selectors that make multi-codepoint emoji render correctly.
    const keep = s.replace(/[^\p{Extended_Pictographic}\u200D\uFE0F\s]/gu, '')
    return keep.replace(/\s+/g, ' ').trim()
}

// Small sleep helper for retry backoff.
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Generate an emoji puzzle for a song title using Gemini. Falls back to the
 * local dictionary when the API key is missing or the call fails so gameplay
 * never blocks on an external service.
 *
 * We pass both title and artist so the model can disambiguate generic titles
 * ("Yellow" by Coldplay → 💛 vs. literal banana) and return emojis that map
 * to the *specific* track rather than one meaning of the word.
 *
 * Retries on 429 with exponential backoff (Gemini free tier rate-limits
 * aggressively, especially on bursty game starts).
 */
export async function generateEmojiPuzzle(
    title: string | null | undefined,
    artist: string | null | undefined
): Promise<string> {
    const fallback = titleToEmoji(title)
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey || typeof title !== 'string' || title.length === 0) {
        return fallback
    }

    const prompt = `You are playing emoji charades. Pick 1 to 4 emojis that help a fan guess this specific song's TITLE.

Song: "${title}"${artist ? ` by ${artist}` : ''}

How to choose:
- Use what you actually know about THIS song — its meaning, mood, lyrics, music video, iconic imagery, cultural references. Not just a dictionary translation of each word.
- The goal is for a fan to recognize the song, not to spell the title word-by-word.
- Concept beats literal when the concept is more recognizable. Examples:
    • "Hooligan" by BTS → 😈🧢🚬 (troublemaker vibe), NOT 🪓💪 (wrong read on the word).
    • "Bohemian Rhapsody" by Queen → 👑🎭🔪 (drama, murder, royalty), not 🎨📜.
    • "Smells Like Teen Spirit" by Nirvana → 🏫🎸😤 (grunge school riot), not 👃🧴.
- Go literal ONLY when the title IS the image: "Watermelon Sugar" → 🍉🍬, "Yellow Submarine" → 💛🚢.
- Use the artist to disambiguate: "Yellow" by Coldplay → 💛⭐ (the stars from the lyrics), not 🍌.

Output rules:
- Output ONLY emojis, no words, punctuation, or explanation.
- Prefer 2–3 emojis. Never exceed 4.
- Never use letter/number/flag emojis (🅰️, 1️⃣, 🇺🇸).`

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`

    const maxAttempts = 4
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 10000)
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.9,
                        maxOutputTokens: 40,
                    }
                }),
                signal: controller.signal,
            })
            clearTimeout(timer)

            if (res.status === 429) {
                // Respect any Retry-After hint; otherwise exponential backoff
                // (1s, 2s, 4s, 8s) with a dash of jitter to avoid thundering
                // herd when all songs in a playlist retry at once.
                const retryAfter = parseInt(res.headers.get('retry-after') || '', 10)
                const base = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * Math.pow(2, attempt)
                const jitter = Math.floor(Math.random() * 400)
                console.warn(`[emoji] Gemini 429 (attempt ${attempt + 1}/${maxAttempts}). Backing off ${base + jitter}ms.`)
                if (attempt < maxAttempts - 1) {
                    await sleep(base + jitter)
                    continue
                }
                return fallback
            }

            if (!res.ok) {
                console.warn('[emoji] Gemini HTTP', res.status, await res.text().catch(() => ''))
                return fallback
            }

            const data = await res.json()
            const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
            const cleaned = stripNonEmoji(text)
            if (!cleaned) return fallback
            // Cap at 4 emojis for readability (matches the prompt ceiling).
            const capped = cleaned.split(/\s+/).filter(Boolean).slice(0, 4).join(' ')
            return capped || fallback
        } catch (e) {
            // Network error or abort — retry up to the attempt cap.
            console.warn(`[emoji] Gemini call failed (attempt ${attempt + 1}/${maxAttempts}):`, e)
            if (attempt < maxAttempts - 1) {
                await sleep(500 * Math.pow(2, attempt))
                continue
            }
            return fallback
        }
    }
    return fallback
}
