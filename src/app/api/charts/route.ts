import { NextRequest, NextResponse } from 'next/server'

// Deezer editorial IDs for country charts — single API call, returns tracks with preview URLs
// No per-track Deezer search needed → zero quota usage
const DEEZER_CHART_IDS: Record<string, number> = {
    worldwide: 0,
    portugal:  3155776642,
}

// Apple Music RSS fallback (metadata only, needs resolution)
const APPLE_CHART_URLS: Record<string, string> = {
    worldwide: 'https://rss.applemarketingtools.com/api/v2/us/music/most-played/100/songs.json',
    portugal:  'https://rss.applemarketingtools.com/api/v2/pt/music/most-played/100/songs.json',
}

async function fetchDeezerChart(editorialId: number, limit = 100) {
    try {
        const res = await fetch(`https://api.deezer.com/chart/${editorialId}/tracks?limit=${limit}`, {
            next: { revalidate: 3600 }
        })
        if (!res.ok) return null
        const data = await res.json()
        if (!data?.data?.length) return null

        const tracks = data.data
            .map((t: any) => ({
                uri: String(t.id),
                name: t.title ?? '',
                artist: t.artist?.name ?? '',
                cover_url: t.album?.cover_xl || t.album?.cover_big || null,
                preview_url: t.preview || null,
            }))
            .filter((t: any) => t.name && t.artist && t.preview_url)

        return tracks.length > 0 ? tracks : null
    } catch {
        return null
    }
}

async function fetchAppleChart(country: string, limit = 100) {
    const url = APPLE_CHART_URLS[country]
    if (!url) return null
    try {
        const res = await fetch(url, { next: { revalidate: 3600 } })
        if (!res.ok) return null
        const data = await res.json()
        const results: any[] = data?.feed?.results ?? []
        return results
            .map((r: any) => ({ name: r.name ?? '', artist: r.artistName ?? '' }))
            .filter((t: any) => t.name && t.artist)
    } catch {
        return null
    }
}

export async function GET(request: NextRequest) {
    const chart = request.nextUrl.searchParams.get('chart')

    if (!chart || !(chart in DEEZER_CHART_IDS)) {
        return NextResponse.json({ error: 'Invalid chart. Use: worldwide | portugal' }, { status: 400 })
    }

    // Try Deezer chart first — complete tracks with preview URLs, no resolution needed
    const deezerTracks = await fetchDeezerChart(DEEZER_CHART_IDS[chart])
    if (deezerTracks) {
        return NextResponse.json({ tracks: deezerTracks, resolved: true })
    }

    // Fallback: Apple Music RSS (metadata only — client will resolve via Deezer search)
    console.warn(`[Charts] Deezer chart failed for "${chart}", falling back to Apple Music RSS`)
    const appleTracks = await fetchAppleChart(chart)
    if (appleTracks) {
        return NextResponse.json({ tracks: appleTracks, resolved: false })
    }

    return NextResponse.json({ error: 'Failed to fetch chart from all sources' }, { status: 500 })
}
