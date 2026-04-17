
export async function fetchLyrics(artist: string, title: string): Promise<string | null> {
    if (!artist || !title) return null

    // Retry logic with backoff for connection stability
    const maxRetries = 2 // Reduced to 2 retries (3 total attempts) to prevent long hangs
    let attempt = 0
    let lastError: any = null

    while (attempt < maxRetries + 1) {
        attempt++
        try {
            const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`

            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 7000) // Increased to 7s for better stability

            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'SongGuesser/1.0 (https://github.com/your-repo)',
                    'Connection': 'close' 
                }
            })
            clearTimeout(timeoutId)

            if (!res.ok) {
                if (res.status === 404) return null
                if (res.status === 429) {
                    console.warn(`[Lyrics] Rate limit (429) for ${artist} - ${title} | Attempt ${attempt}`)
                    // Treat 429 as a retryable error with exponential backoff.
                    // Respect Retry-After header if server provides one.
                    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10)
                    const backoff = retryAfter > 0
                        ? Math.min(10000, retryAfter * 1000)
                        : Math.min(8000, 1000 * Math.pow(2, attempt - 1))
                    lastError = new Error(`429 rate limit`)
                    if (attempt <= maxRetries) {
                        await new Promise(r => setTimeout(r, backoff))
                        continue
                    }
                    // Out of retries on 429 → return null rather than throw, so callers
                    // don't abort game start over a transient limiter.
                    console.error(`[Lyrics] Rate limit persisted after ${attempt} attempts for ${artist} - ${title}`)
                    return null
                }
                throw new Error(`Lyrics API status: ${res.status}`)
            }

            const data = await res.json()
            const lyrics = data.plainLyrics as string

            if (!lyrics) return null
            if (lyrics.includes("Lyrics unavailable for this song.")) return null

            // Process lyrics to get a snippet (random 5-line window)
            const rawLines = lyrics
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)

            const stripTags = (line: string) => line.replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim()

            const noTimestamps = rawLines.filter(line => !/^\[\d{2}:\d{2}\.\d.2\]/.test(line))
            const noSections = noTimestamps.filter(line => !(line.startsWith('[') && line.endsWith(']')))

            const cleanedNoSections = noSections.map(stripTags).filter(Boolean)
            const cleanedNoTimestamps = noTimestamps.map(stripTags).filter(Boolean)
            const cleanedRaw = rawLines.map(stripTags).filter(Boolean)

            // Prefer clean lines, but fall back if too short
            let lines = cleanedNoSections
            if (lines.length < 5) lines = cleanedNoTimestamps
            if (lines.length < 5) lines = cleanedRaw

            const startMax = Math.max(0, lines.length - 5)
            const startIndex = startMax > 0 ? Math.floor(Math.random() * (startMax + 1)) : 0
            const snippet = lines.slice(startIndex, startIndex + 5).join('\n')
            return snippet || null

        } catch (error: any) {
            console.warn(`[Lyrics] ${artist} - ${title} | Attempt ${attempt} failed:`, error.message)
            lastError = error

            if (attempt <= maxRetries) {
                const delay = 500 * Math.pow(2, attempt - 1)
                await new Promise(r => setTimeout(r, delay))
            }
        }
    }

    console.error(`[Lyrics] All attempts failed for ${artist} - ${title}`, lastError?.message || lastError)
    return null
}
