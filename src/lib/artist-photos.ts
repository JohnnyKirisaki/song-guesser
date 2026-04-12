import { getSpotifyAccessToken } from './spotify-auth'
import { fetchDeezerArtistPhoto } from './deezer'
import { normalizeForCompare } from './scoring'

// ── Helpers ─────────────────────────────────────────────────────────
function cleanArtistName(artistName: string): string {
    return artistName
        .replace(/\s*\((feat|ft|with)\.?\s+[^)]+\)/gi, ' ')
        .replace(/\s+(feat|ft|with)\.?\s+.+$/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

// ── Per-artist photo caches ─────────────────────────────────────────
const artistPhotoCache = new Map<string, Promise<string | null>>()
const spotifyArtistPhotoCache = new Map<string, Promise<string | null>>()

// ── Spotify: fetch by artist ID (direct lookup) ────────────────────
async function fetchSpotifyArtistPhotoUncached(artistId: string): Promise<string | null> {
    if (!artistId) return null

    const accessToken = await getSpotifyAccessToken()
    if (!accessToken) return null

    const res = await fetch(`https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        cache: 'no-store',
    }).catch(() => null)

    if (!res?.ok) return null

    const data = await res.json().catch(() => null) as { images?: Array<{ url?: string }> } | null
    return data?.images?.[0]?.url || null
}

// ── Spotify: search by artist name ─────────────────────────────────
async function searchSpotifyArtistPhoto(artistName: string): Promise<string | null> {
    const cleaned = cleanArtistName(artistName)
    if (!cleaned) return null

    const accessToken = await getSpotifyAccessToken()
    if (!accessToken) return null

    const url = `https://api.spotify.com/v1/search?type=artist&q=${encodeURIComponent(cleaned)}&limit=1`
    const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        cache: 'no-store',
    }).catch(() => null)

    if (!res?.ok) return null

    const data = await res.json().catch(() => null) as {
        artists?: { items?: Array<{ images?: Array<{ url?: string }> }> }
    } | null

    return data?.artists?.items?.[0]?.images?.[0]?.url || null
}

// ── Fallback chain: Spotify search → Deezer ────────────────────────
async function fetchArtistPhotoUncached(artistName: string): Promise<string | null> {
    const cleaned = cleanArtistName(artistName)
    if (!cleaned) return null

    const spotifyPhoto = await searchSpotifyArtistPhoto(cleaned).catch(() => null)
    if (spotifyPhoto) return spotifyPhoto

    return fetchDeezerArtistPhoto(cleaned).catch(() => null)
}

// ── Public exports ──────────────────────────────────────────────────

export async function fetchArtistPhoto(artistName: string): Promise<string | null> {
    const cacheKey = normalizeForCompare(cleanArtistName(artistName))
    if (!cacheKey) return null

    const cached = artistPhotoCache.get(cacheKey)
    if (cached) return cached

    const pending = fetchArtistPhotoUncached(artistName).catch(() => null)
    artistPhotoCache.set(cacheKey, pending)
    return pending
}

export async function fetchSpotifyArtistPhoto(artistId: string): Promise<string | null> {
    const cacheKey = artistId.trim()
    if (!cacheKey) return null

    const cached = spotifyArtistPhotoCache.get(cacheKey)
    if (cached) return cached

    const pending = fetchSpotifyArtistPhotoUncached(cacheKey).catch(() => null)
    spotifyArtistPhotoCache.set(cacheKey, pending)
    return pending
}
