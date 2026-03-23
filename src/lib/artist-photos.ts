import { fetchDeezerArtistPhoto } from './deezer'
import { normalizeForCompare } from './scoring'

const WIKIPEDIA_SEARCH_ENDPOINT = 'https://en.wikipedia.org/w/rest.php/v1/search/page'
const WIKIPEDIA_SUMMARY_ENDPOINT = 'https://en.wikipedia.org/api/rest_v1/page/summary/'
const WIKIMEDIA_HEADERS = {
    'Api-User-Agent': 'BeatBattle/1.0 (artist photo lookup)'
}

const MUSIC_DESCRIPTION_HINTS = [
    'singer',
    'rapper',
    'musician',
    'songwriter',
    'record producer',
    'producer',
    'composer',
    'dj',
    'band',
    'duo',
    'group',
    'recording artist',
    'music project',
    'artistic persona',
    'stage persona',
    'musical comedy',
]

const NON_ARTIST_DESCRIPTION_HINTS = [
    'disambiguation page',
    'surname',
    'given name',
    'album by',
    'song by',
    'film',
    'television series',
    'company',
    'city',
    'district',
    'village',
    'municipality',
]

const NON_ARTIST_TITLE_HINTS = [
    'discography',
    'videography',
    'filmography',
    'awards',
    'list of',
    'tour',
    'era',
    'album',
    'song',
    'single',
    'mixtape',
    'soundtrack',
    'episode',
]

const ARTIST_TITLE_OVERRIDES: Record<string, string[]> = {
    'pink guy': ['Pink Guy'],
}

const ARTIST_CANONICAL_PAGE_OVERRIDES: Record<string, string[]> = {
    'pink guy': ['Joji (musician)'],
}

type WikipediaSearchPage = {
    key: string
    title: string
    matched_title?: string | null
    description?: string | null
    thumbnail?: {
        url?: string | null
    } | null
}

type WikipediaSearchResponse = {
    pages?: WikipediaSearchPage[]
}

type WikipediaSummaryResponse = {
    title?: string | null
    description?: string | null
    thumbnail?: {
        source?: string | null
        url?: string | null
    } | null
    originalimage?: {
        source?: string | null
    } | null
}

const artistPhotoCache = new Map<string, Promise<string | null>>()
const spotifyArtistPhotoCache = new Map<string, Promise<string | null>>()

function normalizeImageUrl(url?: string | null): string | null {
    if (!url) return null
    if (url.startsWith('//')) return `https:${url}`
    if (url.startsWith('http://')) return url.replace(/^http:\/\//i, 'https://')
    return url
}

function cleanArtistName(artistName: string): string {
    return artistName
        .replace(/\s*\((feat|ft|with)\.?\s+[^)]+\)/gi, ' ')
        .replace(/\s+(feat|ft|with)\.?\s+.+$/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function looksLikeGroupName(artistName: string): boolean {
    const normalized = artistName.trim().toLowerCase()
    if (!normalized) return false

    return normalized.startsWith('the ') ||
        normalized.includes(' & ') ||
        normalized.includes(' and ') ||
        normalized.includes(' x ') ||
        normalized.includes(' brothers') ||
        normalized.includes(' sisters') ||
        normalized.includes(' orchestra') ||
        normalized.includes(' band') ||
        normalized.includes(' crew') ||
        normalized.includes(' boys') ||
        normalized.includes(' girls')
}

function buildSearchQueries(artistName: string): string[] {
    const base = cleanArtistName(artistName)
    const isGroup = looksLikeGroupName(base)
    const normalizedBase = normalizeForCompare(base)
    const titleOverrides = ARTIST_TITLE_OVERRIDES[normalizedBase] || []
    const canonicalOverrides = ARTIST_CANONICAL_PAGE_OVERRIDES[normalizedBase] || []

    return [...new Set([
        base,
        ...titleOverrides,
        ...canonicalOverrides,
        `${base} singer`,
        `${base} musician`,
        `${base} rapper`,
        `${base} songwriter`,
        isGroup ? `${base} band` : `${base} artist`,
        isGroup ? `${base} group` : `${base} performer`,
    ].filter(Boolean))]
}

function hasMusicDescription(description?: string | null): boolean {
    const normalized = (description || '').toLowerCase()
    return MUSIC_DESCRIPTION_HINTS.some(hint => normalized.includes(hint))
}

function hasNonArtistDescription(description?: string | null): boolean {
    const normalized = (description || '').toLowerCase()
    return NON_ARTIST_DESCRIPTION_HINTS.some(hint => normalized.includes(hint))
}

function hasNonArtistTitle(title?: string | null): boolean {
    const normalized = (title || '').toLowerCase()
    return NON_ARTIST_TITLE_HINTS.some(hint => normalized.includes(hint))
}

function isStrongArtistTitleMatch(artistName: string, title?: string | null): boolean {
    const normalizedArtist = normalizeForCompare(artistName)
    const normalizedTitle = normalizeForCompare(title || '')
    const titleOverrides = ARTIST_TITLE_OVERRIDES[normalizedArtist] || []
    const hasOverrideMatch = titleOverrides.some(override => normalizeForCompare(override) === normalizedTitle)
    const canonicalOverrides = ARTIST_CANONICAL_PAGE_OVERRIDES[normalizedArtist] || []
    const hasCanonicalOverrideMatch = canonicalOverrides.some(override => normalizeForCompare(override) === normalizedTitle)

    return hasOverrideMatch ||
        hasCanonicalOverrideMatch ||
        normalizedTitle === normalizedArtist ||
        normalizedTitle.startsWith(`${normalizedArtist} `) ||
        normalizedTitle === `${normalizedArtist} band`
}

function scoreWikipediaPage(artistName: string, page: WikipediaSearchPage): number {
    const normalizedArtist = normalizeForCompare(artistName)
    const normalizedTitle = normalizeForCompare(page.title || '')
    const normalizedMatchedTitle = normalizeForCompare(page.matched_title || '')
    const description = (page.description || '').toLowerCase()
    const titleTokens = new Set(normalizedTitle.split(' ').filter(Boolean))
    const artistTokens = normalizedArtist.split(' ').filter(Boolean)

    let score = 0

    if (normalizedTitle === normalizedArtist) score += 120
    if (normalizedMatchedTitle === normalizedArtist) score += 90
    if (normalizedTitle.startsWith(`${normalizedArtist} `)) score += 55
    if (normalizedArtist && normalizedTitle.includes(normalizedArtist)) score += 35

    const matchingTokenCount = artistTokens.filter(token => titleTokens.has(token)).length
    if (matchingTokenCount > 0) {
        score += matchingTokenCount * 12
        if (matchingTokenCount === artistTokens.length) score += 20
    }

    if (page.thumbnail?.url) score += 25
    if (hasMusicDescription(description)) score += 70
    if (hasNonArtistDescription(description)) score -= 80
    if (hasNonArtistTitle(page.title)) score -= 140
    if (!isStrongArtistTitleMatch(artistName, page.title) && matchingTokenCount < Math.max(1, artistTokens.length - 1)) score -= 100

    return score
}

async function fetchWikipediaSummary(title: string): Promise<WikipediaSummaryResponse | null> {
    const res = await fetch(`${WIKIPEDIA_SUMMARY_ENDPOINT}${encodeURIComponent(title)}`, {
        cache: 'no-store',
        headers: WIKIMEDIA_HEADERS,
    })

    if (!res.ok) return null
    return await res.json() as WikipediaSummaryResponse
}

async function fetchExactWikipediaArtistPhoto(artistName: string): Promise<string | null> {
    const cleanedName = cleanArtistName(artistName)
    const titleOverrides = ARTIST_TITLE_OVERRIDES[normalizeForCompare(cleanedName)] || []
    const canonicalOverrides = ARTIST_CANONICAL_PAGE_OVERRIDES[normalizeForCompare(cleanedName)] || []
    const candidates = [...new Set([cleanedName, ...titleOverrides, ...canonicalOverrides].filter(Boolean))]

    for (const candidate of candidates) {
        const summary = await fetchWikipediaSummary(candidate).catch(() => null)
        if (!summary) continue
        if (!isStrongArtistTitleMatch(artistName, summary.title)) continue
        if (!hasMusicDescription(summary.description) || hasNonArtistDescription(summary.description) || hasNonArtistTitle(summary.title)) continue

        const imageUrl = normalizeImageUrl(summary.originalimage?.source || summary.thumbnail?.source || summary.thumbnail?.url)
        if (imageUrl) return imageUrl
    }

    return null
}

async function searchWikipediaPages(query: string): Promise<WikipediaSearchPage[]> {
    const url = new URL(WIKIPEDIA_SEARCH_ENDPOINT)
    url.searchParams.set('q', query)
    url.searchParams.set('limit', '8')

    const res = await fetch(url.toString(), {
        cache: 'no-store',
        headers: WIKIMEDIA_HEADERS,
    })

    if (!res.ok) return []

    const data = await res.json() as WikipediaSearchResponse
    return Array.isArray(data.pages) ? data.pages : []
}

async function fetchWikimediaArtistPhoto(artistName: string): Promise<string | null> {
    const exactPhoto = await fetchExactWikipediaArtistPhoto(artistName).catch(() => null)
    if (exactPhoto) return exactPhoto

    for (const query of buildSearchQueries(artistName)) {
        const pages = await searchWikipediaPages(query)
        const ranked = pages
            .map(page => ({ page, score: scoreWikipediaPage(artistName, page) }))
            .filter(result => !!result.page.thumbnail?.url)
            .sort((a, b) => b.score - a.score)

        const best = ranked[0]
        if (best && best.score >= 150 && isStrongArtistTitleMatch(artistName, best.page.title) && !hasNonArtistTitle(best.page.title)) {
            return normalizeImageUrl(best.page.thumbnail?.url)
        }
    }

    return null
}

async function fetchArtistPhotoUncached(artistName: string): Promise<string | null> {
    const cleanedArtist = cleanArtistName(artistName)
    if (!cleanedArtist) return null

    const wikimediaPhoto = await fetchWikimediaArtistPhoto(cleanedArtist).catch(() => null)
    if (wikimediaPhoto) return wikimediaPhoto

    return fetchDeezerArtistPhoto(cleanedArtist).catch(() => null)
}

async function fetchSpotifyAccessToken(): Promise<string | null> {
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
    if (!clientId || !clientSecret) return null

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        cache: 'no-store',
    }).catch(() => null)

    if (!res?.ok) return null
    const data = await res.json().catch(() => null) as { access_token?: string } | null
    return data?.access_token || null
}

async function fetchSpotifyArtistPhotoUncached(artistId: string): Promise<string | null> {
    if (!artistId) return null

    const accessToken = await fetchSpotifyAccessToken()
    if (!accessToken) return null

    const res = await fetch(`https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        cache: 'no-store',
    }).catch(() => null)

    if (!res?.ok) return null

    const data = await res.json().catch(() => null) as { images?: Array<{ url?: string | null }> } | null
    const imageUrl = data?.images?.[0]?.url || null
    return normalizeImageUrl(imageUrl)
}

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
