/**
 * clear-song-cache.ts
 * Clears the Deezer track resolution cache from Firebase Realtime Database.
 * Run with:  npx ts-node scripts/clear-song-cache.ts
 */

import { initializeApp } from 'firebase/app'
import { getDatabase, ref, remove, get } from 'firebase/database'

const firebaseConfig = {
    apiKey: 'AIzaSyDq0X64s2w532lTZ8XcTdLU8JRzOAabEHw',
    authDomain: 'beatbattle-e02aa.firebaseapp.com',
    databaseURL: 'https://beatbattle-e02aa-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'beatbattle-e02aa',
    storageBucket: 'beatbattle-e02aa.firebasestorage.app',
    messagingSenderId: '1041147594033',
    appId: '1:1041147594033:web:5b3ce470b89f221b695c10'
}

const CACHE_PATH = 'server_state/deezer_track_cache'

async function main() {
    const app = initializeApp(firebaseConfig)
    const db = getDatabase(app)
    const cacheRef = ref(db, CACHE_PATH)

    // Count entries first
    const snap = await get(cacheRef)
    if (!snap.exists()) {
        console.log('✅ Cache is already empty — nothing to clear.')
        process.exit(0)
    }

    const count = Object.keys(snap.val()).length
    console.log(`🗑️  Found ${count} cached track(s). Clearing...`)

    await remove(cacheRef)
    console.log(`✅ Done! All ${count} cached tracks have been cleared.`)
    console.log('   Songs will be re-resolved fresh on next playlist import.')
    process.exit(0)
}

main().catch(err => {
    console.error('❌ Failed to clear cache:', err)
    process.exit(1)
})
