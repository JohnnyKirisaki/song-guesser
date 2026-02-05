import { NextResponse } from 'next/server'
import { db } from '@/lib/firebase'
import { ref, get, update } from 'firebase/database'

export async function GET(request: Request) {
    // Basic Security: Check for CRON_SECRET if you want to prevent unauthorized manual calls
    // For now, let's just implement the logic.

    try {
        console.log('[Cleanup] Starting room cleanup...')
        const roomsRef = ref(db, 'rooms')
        const snapshot = await get(roomsRef)

        if (!snapshot.exists()) {
            return NextResponse.json({ message: 'No rooms found' })
        }

        const rooms = snapshot.val()
        const now = Date.now()
        const oneHourAgo = now - (60 * 60 * 1000)

        const updates: Record<string, any> = {}
        let deleteCount = 0

        Object.entries(rooms).forEach(([code, room]: [string, any]) => {
            const createdAtStr = room.created_at
            if (!createdAtStr) return

            const createdAt = new Date(createdAtStr).getTime()

            // If room is older than 1 hour
            if (createdAt < oneHourAgo) {
                updates[code] = null // Setting to null deletes the node in recursive update
                deleteCount++
            }
        })

        if (deleteCount > 0) {
            // Use update on the parent 'rooms' ref to perform bulk delete
            await update(roomsRef, updates)
            console.log(`[Cleanup] Successfully deleted ${deleteCount} rooms.`)
        } else {
            console.log('[Cleanup] No rooms required deletion.')
        }

        return NextResponse.json({
            success: true,
            deleted: deleteCount,
            message: `Deleted ${deleteCount} expired rooms`
        })

    } catch (error: any) {
        console.error('[Cleanup] Error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
