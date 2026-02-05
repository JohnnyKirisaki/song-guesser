import { NextResponse } from 'next/server'

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
        return NextResponse.json({ error: 'Missing track ID' }, { status: 400 })
    }

    try {
        const res = await fetch(`https://api.deezer.com/track/${id}`)
        if (!res.ok) throw new Error('Failed to fetch from Deezer')

        const data = await res.json()

        // Handle Deezer API errors
        if (data.error) {
            throw new Error(data.error.message || 'Deezer API Error')
        }

        const preview_url = data.preview || null

        return NextResponse.json({ preview_url })
    } catch (error: any) {
        console.error('Refresh Track Error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
