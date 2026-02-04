import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url)
    const artist = searchParams.get('artist')
    const title = searchParams.get('title')

    if (!artist || !title) {
        return NextResponse.json({ error: 'Missing artist or title' }, { status: 400 })
    }

    try {
        // Using LRCLIB (Free, Open Source, No Key)
        // https://lrclib.net/docs
        const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`

        const res = await fetch(url, {
            headers: {
                'User-Agent': 'SongGuesser/1.0 (https://github.com/your-repo)'
            }
        })

        if (!res.ok) {
            if (res.status === 404) {
                console.warn('[API] Lyrics not found on LRCLIB')
                return NextResponse.json({ lyrics: null })
            }
            console.warn('[API] LRCLIB fetch failed:', res.status, res.statusText)
            return NextResponse.json({ lyrics: null })
        }

        const data = await res.json()
        const lyrics = data.plainLyrics as string

        if (!lyrics) return NextResponse.json({ lyrics: null })

        // Process lyrics to get a snippet (first 5 lines)
        const cleanLines = lyrics.split('\n')
            .filter(line => line.trim() !== '' && !line.startsWith('['))
            .slice(0, 5)
            .join('\n')

        return NextResponse.json({ lyrics: cleanLines || null })

    } catch (error) {
        console.error('Lyrics fetch error:', error)
        return NextResponse.json({ lyrics: null })
    }
}
