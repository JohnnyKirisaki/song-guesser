import { NextRequest, NextResponse } from 'next/server'
import { fetchLyrics } from '@/lib/lyrics'

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url)
    const artist = searchParams.get('artist')?.trim()
    const title = searchParams.get('title')?.trim()

    if (!artist || !title) {
        return NextResponse.json({ error: 'Missing artist or title' }, { status: 400 })
    }

    if (artist === '???' || title === '???') {
        return NextResponse.json({ lyrics: null })
    }

    const lyrics = await fetchLyrics(artist, title)

    return NextResponse.json({ lyrics })
}
