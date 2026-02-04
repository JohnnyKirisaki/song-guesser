import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export async function GET() {
    try {
        const emotesDir = path.join(process.cwd(), 'public', 'emotes')

        if (!fs.existsSync(emotesDir)) {
            return NextResponse.json({ emotes: [] })
        }

        const files = fs.readdirSync(emotesDir)

        // Filter for image files only
        const emotes = files
            .filter(file => /\.(png|gif|jpe?g|webp|avif)$/i.test(file))
            .map(file => `/emotes/${file}`)

        return NextResponse.json({ emotes })
    } catch (error) {
        console.error('Error reading emotes directory:', error)
        return NextResponse.json({ error: 'Failed to load emotes' }, { status: 500 })
    }
}
