import { NextRequest, NextResponse } from 'next/server'

type YouTubeTrack = {
    artist: string
    name: string
}

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams
    const playlistUrl = searchParams.get('url')

    if (!playlistUrl) {
        return NextResponse.json({ error: 'Missing playlist URL' }, { status: 400 })
    }

    // Extract playlist ID from URL
    const playlistId = extractPlaylistId(playlistUrl)
    if (!playlistId) {
        return NextResponse.json({ error: 'Invalid YouTube playlist URL' }, { status: 400 })
    }

    try {
        // Fetch the playlist page
        const response = await fetch(`https://www.youtube.com/playlist?list=${playlistId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        })

        if (!response.ok) {
            throw new Error('Failed to fetch playlist')
        }

        const html = await response.text()

        // Extract the initial data JSON from the page
        const tracks = parsePlaylistHTML(html)

        return NextResponse.json({ tracks })
    } catch (error: any) {
        console.error('[YouTube API] Error:', error)
        return NextResponse.json({ error: error.message || 'Failed to parse playlist' }, { status: 500 })
    }
}

function extractPlaylistId(url: string): string | null {
    // Handle various YouTube playlist URL formats
    const patterns = [
        /[?&]list=([^&]+)/,  // Standard: ?list=PLxxx
        /youtube\.com\/playlist\?list=([^&]+)/,
        /music\.youtube\.com\/playlist\?list=([^&]+)/
    ]

    for (const pattern of patterns) {
        const match = url.match(pattern)
        if (match) return match[1]
    }

    return null
}

function parsePlaylistHTML(html: string): YouTubeTrack[] {
    const tracks: YouTubeTrack[] = []

    try {
        // YouTube embeds playlist data in a script tag as JSON
        // Look for: var ytInitialData = {...}
        const match = html.match(/var ytInitialData = ({.+?});/)
        if (!match) {
            throw new Error('Could not find playlist data in page')
        }

        const data = JSON.parse(match[1])

        // Navigate the YouTube data structure
        const contents = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents

        if (!contents) {
            throw new Error('Unexpected playlist data structure')
        }

        // Extract track info from each video
        for (const item of contents) {
            const videoRenderer = item?.playlistVideoRenderer
            if (!videoRenderer) continue

            const title = videoRenderer?.title?.runs?.[0]?.text
            const byline = videoRenderer?.shortBylineText?.runs?.[0]?.text

            if (title) {
                const parsed = parseYouTubeTitle(title, byline)
                if (parsed) {
                    tracks.push(parsed)
                }
            }
        }

        return tracks
    } catch (error) {
        console.error('[YouTube Parser] Error:', error)
        throw new Error('Failed to parse playlist data')
    }
}

function parseYouTubeTitle(title: string, channelName?: string): YouTubeTrack | null {
    // Clean up common YouTube title patterns
    let cleaned = title
        .replace(/\(Official (?:Music )?Video\)/gi, '')
        .replace(/\(Official Audio\)/gi, '')
        .replace(/\(Lyric Video\)/gi, '')
        .replace(/\(Lyrics\)/gi, '')
        .replace(/\[Official (?:Music )?Video\]/gi, '')
        .replace(/\[Official Audio\]/gi, '')
        .replace(/\[Lyric Video\]/gi, '')
        .replace(/\[Lyrics\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim()

    // Try to split by common separators: " - ", " – ", " | "
    const separators = [' - ', ' – ', ' — ', ' | ']

    for (const sep of separators) {
        if (cleaned.includes(sep)) {
            const parts = cleaned.split(sep)
            if (parts.length >= 2) {
                return {
                    artist: parts[0].trim(),
                    name: parts.slice(1).join(sep).trim()
                }
            }
        }
    }

    // Fallback: Use channel name as artist if available
    if (channelName) {
        return {
            artist: channelName,
            name: cleaned
        }
    }

    // Last resort: Use title as track name, empty artist
    return {
        artist: '',
        name: cleaned
    }
}
