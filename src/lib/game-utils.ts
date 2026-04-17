/**
 * Cryptographically-secure room code generator. Uses crypto.getRandomValues
 * with rejection sampling so every character in the output alphabet is equally
 * likely (a naive `u8 % 36` would bias the first 4 characters — a small but
 * real hit to effective entropy). Falls back to Math.random ONLY if crypto is
 * unavailable (very old runtimes / SSR without the polyfill).
 *
 * 6 chars from a 36-char alphabet = ~31 bits of entropy (~2.2B combinations),
 * which is more than enough to deter trivial room-hopping.
 */
export function generateRoomCode(length: number = 6): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const alphabetLen = chars.length

    const getCrypto = (): Crypto | null => {
        if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
            return globalThis.crypto
        }
        return null
    }

    const cryptoObj = getCrypto()
    if (!cryptoObj) {
        // Defensive fallback. In practice unreachable in modern Node + all
        // supported browsers, but avoids hard-crashing if called from an
        // unusual runtime.
        let fallback = ''
        for (let i = 0; i < length; i++) {
            fallback += chars.charAt(Math.floor(Math.random() * alphabetLen))
        }
        return fallback
    }

    // Rejection-sampling on u8: reject any byte >= floor(256/36)*36 = 252 so
    // the accepted range is an exact multiple of 36. Keeps the distribution
    // uniform without the mod-bias.
    const maxAcceptable = Math.floor(256 / alphabetLen) * alphabetLen
    let result = ''
    // Pull bytes in reasonably-sized chunks so we rarely need a refill even
    // under heavy rejection.
    while (result.length < length) {
        const needed = length - result.length
        const buf = new Uint8Array(needed * 2)
        cryptoObj.getRandomValues(buf)
        for (let i = 0; i < buf.length && result.length < length; i++) {
            if (buf[i] < maxAcceptable) {
                result += chars.charAt(buf[i] % alphabetLen)
            }
        }
    }
    return result
}

/**
 * Fisher-Yates Shuffle algorithm for true randomness
 */
export function shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array]
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled
}
