
import { db } from './firebase'
import { ref, get, set } from 'firebase/database'
import { getSpotifyAccessToken } from './spotify-auth'
import { detectLanguage, languageFromGenres, LanguageCode } from './language-detector'
import { asyncPool } from './async-utils'

export type ArtistMetadata = {
    name: string
    lang: LanguageCode
    genres: string[]
    last_updated: number
    schema_version?: number
}

const METADATA_CACHE_PATH = 'server_state/artist_metadata_cache'

// Bump whenever the language/genre inference changes so stale cached
// entries get re-evaluated instead of sticking with a wrong `lang` forever.
// v2: added genre-based language override (languageFromGenres).
// v3: split 'pt' into 'pt-br' / 'pt-pt' so Brazilian and European
//     Portuguese artists aren't paired with each other first.
const METADATA_SCHEMA_VERSION = 3

/**
 * Fetches and caches metadata (Language & Type) for a list of artists.
 * Uses Firebase as a persistent cache to avoid redundant API calls.
 */
export async function getArtistMetadataBatch(
    artists: { name: string; spotify_artist_id?: string | null; titles: string[] }[]
): Promise<Record<string, ArtistMetadata>> {
    const results: Record<string, ArtistMetadata> = {}
    const missing: typeof artists = []

    // 1. Check Firebase Cache first. Treat entries without the current
    // schema_version as stale so old (possibly wrongly-tagged) rows get
    // re-evaluated under the new rules.
    await Promise.all(artists.map(async (a) => {
        const cacheKey = a.name.toLowerCase().trim().replace(/[.#$\[\]]/g, '_')
        const snap = await get(ref(db, `${METADATA_CACHE_PATH}/${cacheKey}`))
        if (snap.exists()) {
            const cached = snap.val() as ArtistMetadata
            if (cached.schema_version === METADATA_SCHEMA_VERSION) {
                results[a.name] = cached
                return
            }
        }
        missing.push(a)
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
        const genres = a.spotify_artist_id ? (genreMap[a.spotify_artist_id] || []) : []

        // Prefer Spotify genre signal — an artist tagged "sertanejo" or
        // "k-pop" isn't singing in English, even if their titles happen
        // to romanize cleanly. Fall back to title-based detection when
        // genres give no language hint (common for instrumental / DIY /
        // genre-less artists).
        const genreLang = languageFromGenres(genres)
        const titleLang = detectLanguage(a.titles.join(' '))
        const detectedLang: LanguageCode = genreLang ?? titleLang

        const metadata: ArtistMetadata = {
            name: a.name,
            lang: detectedLang,
            genres: genres,
            last_updated: Date.now(),
            schema_version: METADATA_SCHEMA_VERSION,
        }

        // Save to Firebase Cache (Fire and forget, don't block match start)
        const cacheKey = a.name.toLowerCase().trim().replace(/[.#$\[\]]/g, '_')
        set(ref(db, `${METADATA_CACHE_PATH}/${cacheKey}`), metadata).catch(() => null)

        results[a.name] = metadata
    })

    return results
}
