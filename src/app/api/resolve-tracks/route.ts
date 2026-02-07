import { NextResponse } from 'next/server'
import { resolvePlaylist } from '@/lib/deezer'

export async function POST(req: Request) {
    try {
        const body = await req.json()
        const { tracks, clearLog } = body

        if (!tracks || !Array.isArray(tracks)) {
            return NextResponse.json({ error: 'Invalid tracks array' }, { status: 400 })
        }

        // Limit batch size purely for safety
        if (tracks.length > 3000) {
            return NextResponse.json({ error: 'Playlist too large (max 3000)' }, { status: 400 })
        }

        const resolved = await resolvePlaylist(tracks, clearLog)

        return NextResponse.json({
            success: true,
            count: resolved.length,
            tracks: resolved
        })

    } catch (error: any) {
        console.error('[API] Resolution Error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
