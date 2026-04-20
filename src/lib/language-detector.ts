
// Compound codes like "pt-br" / "pt-pt" let us distinguish regional
// variants that sound/feel noticeably different even when they share a
// base language. The text-based detector can't reliably tell a Brazilian
// song from a European Portuguese one from lyrics alone, but Spotify
// genre strings are very distinct (sertanejo ≠ fado), so we reserve the
// regional tags for genre-sourced detections and leave text-sourced
// results at the bare language code.
export type LanguageCode = 'en' | 'pt' | 'pt-br' | 'pt-pt' | 'es' | 'ko' | 'ja' | 'ru' | 'other'

/**
 * Returns the base language ("family") for a language code — pt-br → pt,
 * pt-pt → pt, en → en. Used by the Who Sang That imposter picker to
 * prefer same-region artists first, then fall back to same-family
 * artists, before ever widening to a different language entirely.
 */
export function baseLang(code: LanguageCode | null | undefined): string | null {
    if (!code) return null
    return code.split('-')[0]
}

const PT_KEYWORDS = new Set(['que', 'do', 'da', 'os', 'as', 'de', 'em', 'um', 'para', 'com', 'não', 'mais', 'como', 'mas', 'foi', 'uma', 'você', 'eu', 'me', 'te', 'meu', 'minha', 'seu', 'sua', 'nós', 'tudo', 'só', 'quando', 'ser', 'estar', 'tem', 'ter', 'pra', 'né', 'cê', 'vai', 'vou', 'amor', 'coração'])
const ES_KEYWORDS = new Set(['y', 'el', 'la', 'los', 'las', 'en', 'de', 'que', 'no', 'es', 'se', 'un', 'una', 'con', 'por', 'lo', 'su', 'yo', 'tú', 'mi', 'te', 'me', 'más', 'pero', 'todo', 'sólo', 'cuando', 'ser', 'está', 'tiene', 'corazón'])
const EN_KEYWORDS = new Set(['the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at'])

// Spotify genre strings are surprisingly reliable for language identification.
// When the title-only detector is weak (short titles, no diacritics), genre
// strings are the strongest signal we've got — a "sertanejo" artist isn't
// ever going to be singing in English.
const GENRE_LANG_MARKERS: Array<[RegExp, LanguageCode]> = [
    // Brazilian Portuguese markers. These are the uniquely-Brazilian
    // genres — mpb, sertanejo, samba, bossa, forró, pagode, funk carioca,
    // trap brasileiro — plus any genre explicitly tagged "brazilian".
    [/\b(mpb|sertanejo|samba|bossa ?nova|forr[oó]|pagode|funk carioca|funk bh|funk paulista|trap brasileiro|rap brasileiro|brazilian)\b/i, 'pt-br'],
    // European Portuguese markers. Fado + "portuguese" prefix genres
    // (portuguese pop, portuguese rock, portuguese hip hop). Kizomba is
    // Angolan but culturally/linguistically closer to pt-pt than pt-br
    // and Angolan artists are often lumped into the same imposter pool.
    [/\b(fado|portuguese|kizomba|lusophone|pimba)\b/i, 'pt-pt'],
    // Spanish / Latin: reggaeton, bachata, salsa, cumbia, mariachi, flamenco,
    // ranchera, corridos, banda, vallenato, 'latin *', 'spanish *'
    [/\b(reggaeton|bachata|salsa|cumbia|mariachi|flamenco|ranchera|corridos?|banda|vallenato|latin|spanish|tejano|norte[nñ]o|regional mexican)\b/i, 'es'],
    // Korean: k-pop, k-rap, k-indie, k-rock, korean *
    [/\b(k-?pop|k-?rap|k-?indie|k-?rock|k-?ballad|korean)\b/i, 'ko'],
    // Japanese: j-pop, j-rock, anime, city pop, vocaloid
    [/\b(j-?pop|j-?rock|j-?idol|japanese|anime|city pop|vocaloid|enka)\b/i, 'ja'],
    // Russian: 'russian *', 'russian rap', 'russian rock'
    [/\b(russian|russkiy|russ\.? ?pop)\b/i, 'ru'],
]

/**
 * Infer language from a list of Spotify genre strings. Returns null when no
 * genre strings match a known marker — callers should fall back to
 * text-based detection.
 */
export function languageFromGenres(genres: string[] | null | undefined): LanguageCode | null {
    if (!genres || genres.length === 0) return null
    const joined = genres.join(' ')
    for (const [pattern, lang] of GENRE_LANG_MARKERS) {
        if (pattern.test(joined)) return lang
    }
    return null
}

// Unique characters to boost confidence
const PT_CHARS = /[ãõçáàéíóú]/i
const ES_CHARS = /[ñ¿¡íóúáé]/i

/**
 * Lightweight language detector for lyrics excerpts.
 * Prioritizes speed and common script detection.
 */
export function detectLanguage(text: string): LanguageCode {
    if (!text) return 'en'

    // 1. Script-based detection (high confidence)
    if (/[\uAC00-\uD7AF]/.test(text)) return 'ko' // Hangul
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja' // Hiragana/Katakana
    if (/[\u0400-\u04FF]/.test(text)) return 'ru' // Cyrillic
    if (/[\u0600-\u06FF]/.test(text)) return 'other' // Arabic (tagged as other for now)

    // 2. Latin Heuristics (Portuguese vs Spanish vs English)
    const words = text.toLowerCase().split(/[^\w\u00A0-\u00FF]+/).filter(w => w.length > 0)
    if (words.length === 0) return 'en'

    let ptScore = 0
    let esScore = 0
    let enScore = 0

    // Boost scores based on specific characters
    if (PT_CHARS.test(text)) ptScore += 2
    if (ES_CHARS.test(text)) esScore += 2

    words.forEach(word => {
        if (PT_KEYWORDS.has(word)) ptScore++
        if (ES_KEYWORDS.has(word)) esScore++
        if (EN_KEYWORDS.has(word)) enScore++
    })

    // Debugging (optional)
    // console.log(`[LangDetect] PT: ${ptScore}, ES: ${esScore}, EN: ${enScore}`)

    if (ptScore > esScore && ptScore > enScore) return 'pt'
    if (esScore > ptScore && esScore > enScore) return 'es'
    
    // Default to English if Latin script but no strong PT/ES signals
    return 'en'
}
