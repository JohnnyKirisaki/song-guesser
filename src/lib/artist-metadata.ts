
import { db } from './firebase'
import { ref, get, set } from 'firebase/database'
import { getSpotifyAccessToken } from './spotify-auth'
import { detectLanguage, LanguageCode } from './language-detector'
import { asyncPool } from './async-utils'

export type ArtistMetadata = {
    name: string
    lang: LanguageCode
    genres: string[]
    last_updated: number
}

const METADATA_CACHE_PATH = 'server_state/artist_metadata_cache'

/**
 * Fetches and caches metadata (Language & Type) for a list of artists.
 * Uses Firebase as a persistent cache to avoid redundant API calls.
 */
export async function getArtistMetadataBatch(
    artists: { name: string; spotify_artist_id?: string | null; titles: string[] }[]
): Promise<Record<string, ArtistMetadata>> {
    const results: Record<string, ArtistMetadata> = {}
    const missing: typeof artists = []

    // 1. Check Firebase Cache first
    await Promise.all(artists.map(async (a) => {
        const cacheKey = a.name.toLowerCase().trim().replace(/[.#$\[\]]/g, '_')
        const snap = await get(ref(db, `${METADATA_CACHE_PATH}/${cacheKey}`))
        if (snap.exists()) {
            results[a.name] = snap.val()
        } else {
            missing.push(a)
        }
    }))

    if (missing.length === 0) return results

    // 2. Resolve missing metadata
    const accessToken = await getSpotifyAccessToken()

    // 2a. Batch Genre Lookup via Spotify (for those with IDs)
    const withIds = missing.filter(m => !!m.spotify_artist_id)
    const genreMap: Record<string, string[]> = {}
    
    if (accessToken && withIds.length > 0) {
        // Spotify /artists endpoint supports up to 50 IDs
        const chunks: string[][] = []
        for (let i = 0; i < withIds.length; i += 50) {
            chunks.push(withIds.slice(i, i + 50).map(m => m.spotify_artist_id!) as string[])
        }

        await Promise.all(chunks.map(async (ids) => {
            try {
                const res = await fetch(`https://api.spotify.com/v1/artists?ids=${ids.join(',')}`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                })
                if (!res.ok) return
                const data = await res.json()
                data.artists.forEach((artist: any) => {
                    if (artist) genreMap[artist.id] = artist.genres || []
                })
            } catch (e) {
                console.error('[ArtistMetadata] Spotify batch lookup failed', e)
            }
        }))
    }

    // 2b. Language Detection & Final Assembly
    await asyncPool(5, missing, async (a) => {
        const detectedLang = detectLanguage(a.titles.join(' '))
        const genres = a.spotify_artist_id ? (genreMap[a.spotify_artist_id] || []) : []
        
        const metadata: ArtistMetadata = {
            name: a.name,
            lang: detectedLang,
            genres: genres,
            last_updated: Date.now()
        }

        // Save to Firebase Cache (Fire and forget, don't block match start)
        const cacheKey = a.name.toLowerCase().trim().replace(/[.#$\[\]]/g, '_')
        set(ref(db, `${METADATA_CACHE_PATH}/${cacheKey}`), metadata).catch(() => null)

        results[a.name] = metadata
    })

    return results
}
