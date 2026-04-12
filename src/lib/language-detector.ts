
export type LanguageCode = 'en' | 'pt' | 'es' | 'ko' | 'ja' | 'ru' | 'other'

const PT_KEYWORDS = new Set(['que', 'do', 'da', 'os', 'as', 'de', 'em', 'um', 'para', 'com', 'não', 'mais', 'como', 'mas', 'foi', 'uma'])
const ES_KEYWORDS = new Set(['y', 'el', 'la', 'los', 'las', 'en', 'de', 'que', 'no', 'es', 'se', 'un', 'una', 'con', 'por', 'lo', 'su'])
const EN_KEYWORDS = new Set(['the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at'])

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
