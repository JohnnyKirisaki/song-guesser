
export async function fetchLyrics(artist: string, title: string): Promise<string | null> {
    if (!artist || !title) return null

    // Retry logic with backoff for connection stability
    const maxRetries = 3
    let attempt = 0
    let lastError: any = null

    while (attempt < maxRetries) {
        attempt++
        try {
            // Using LRCLIB (Free, Open Source, No Key)
            const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`

            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'SongGuesser/1.0 (https://github.com/your-repo)',
                    'Connection': 'close' // Prevent socket hanging
                }
            })

            if (!res.ok) {
                if (res.status === 404) return null
                throw new Error(`Lyrics API status: ${res.status}`)
            }

            const data = await res.json()
            const lyrics = data.plainLyrics as string

            if (!lyrics) return null
            if (lyrics.includes("Lyrics unavailable for this song.")) return null

            // Process lyrics to get a snippet (first 5 lines)
            const rawLines = lyrics
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)

            const stripTags = (line: string) => line.replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim()

            const noTimestamps = rawLines.filter(line => !/^\[\d{2}:\d{2}\.\d{2}\]/.test(line))
            const noSections = noTimestamps.filter(line => !(line.startsWith('[') && line.endsWith(']')))

            const cleanedNoSections = noSections.map(stripTags).filter(Boolean)
            const cleanedNoTimestamps = noTimestamps.map(stripTags).filter(Boolean)
            const cleanedRaw = rawLines.map(stripTags).filter(Boolean)

            // Prefer clean lines, but fall back if too short
            let lines = cleanedNoSections
            if (lines.length < 5) lines = cleanedNoTimestamps
            if (lines.length < 5) lines = cleanedRaw

            const snippet = lines.slice(0, 5).join('\n')
            return snippet || null

        } catch (error: any) {
            console.warn(`Lyrics fetch attempt ${attempt} failed:`, error.message)
            lastError = error

            // Wait before retry (exponential backoff: 500ms, 1000ms, 2000ms...)
            if (attempt < maxRetries) {
                const delay = 500 * Math.pow(2, attempt - 1)
                await new Promise(r => setTimeout(r, delay))
            }
        }
    }

    console.error('All lyrics fetch attempts failed', lastError)
    return null
}
