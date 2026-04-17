import { useRef } from 'react'
import type { SongItem } from '@/lib/game-logic'

/**
 * Audio preview URL resolver, extracted from GamePage to isolate the
 * fetch-and-cache logic from UI state. Owns:
 *   - a per-song override cache (populated when we fetch a fresher URL)
 *   - in-flight prefetch dedup + 10s cooldown
 *   - resolver strategies (Deezer ID refresh, meta re-resolve) raced in parallel
 *
 * Consumers still own the <audio> element, retry counters, and lifecycle —
 * this hook only answers "what URL should we play for this song right now?"
 */
export function usePreviewResolver() {
    const audioPreviewOverrideRef = useRef<Record<string, string>>({})
    const audioPrefetchRef = useRef<Record<string, number>>({})
    const audioPrefetchInFlightRef = useRef<Record<string, boolean>>({})
    const audioPrefetchPromisesRef = useRef<Record<string, Promise<string | null> | null>>({})

    const resolvePreviewForSong = async (song: SongItem): Promise<string | null> => {
        if (!song) return null
        const cached = audioPreviewOverrideRef.current[song.id]
        if (cached) return cached

        const trackId = song.spotify_uri
        const isDeezerId = typeof trackId === 'string' && /^\d+$/.test(trackId)
        const isMasked = song.artist_name === '???' || song.track_name === '???'

        const tryRefreshById = async (): Promise<string | null> => {
            if (!isDeezerId) return null
            try {
                const res = await fetch(`/api/refresh-track?id=${trackId}`, { cache: 'no-store' })
                const data = await res.json()
                if (data.preview_url) return data.preview_url.replace(/^http:\/\//i, 'https://')
            } catch (err) {
                console.error('[Audio] ID refresh failed:', err)
            }
            return null
        }

        const tryResolveByMeta = async (): Promise<string | null> => {
            if (isMasked || !song.artist_name || !song.track_name) return null
            try {
                const res = await fetch('/api/resolve-tracks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    cache: 'no-store',
                    body: JSON.stringify({ tracks: [{ artist: song.artist_name, title: song.track_name }] })
                })
                const data = await res.json()
                const resolved = data?.tracks?.find((t: any) => t?.resolved && t?.deezer?.preview_url)
                if (resolved?.deezer?.preview_url) return resolved.deezer.preview_url.replace(/^http:\/\//i, 'https://')
            } catch (err) {
                console.error('[Audio] Meta resolution failed:', err)
            }
            return null
        }

        // Fire both strategies simultaneously — whichever returns a URL first wins.
        const [fromId, fromMeta] = await Promise.all([tryRefreshById(), tryResolveByMeta()])
        const newUrl = fromId || fromMeta

        if (newUrl && song.id) {
            audioPreviewOverrideRef.current[song.id] = newUrl
        }
        return newUrl || null
    }

    const isPreviewExpired = (url: string, nowSeconds: number, leewaySeconds = 0) => {
        const matchExp = url.match(/exp=(\d+)/)
        const expTime = matchExp ? parseInt(matchExp[1]) : 0
        return expTime > 0 && expTime < nowSeconds + leewaySeconds
    }

    const getPreviewStatus = (song: SongItem) => {
        const previewUrl = typeof song.preview_url === 'string' ? song.preview_url.trim() : ''
        const normalizedPreview = previewUrl.replace(/^http:\/\//i, 'https://')
        const overridePreview = song.id ? audioPreviewOverrideRef.current[song.id] : null
        const previewToUse = overridePreview || normalizedPreview
        const hasValidPreview = previewToUse.length > 0 && previewToUse.startsWith('http')
        const nowSeconds = Math.floor(Date.now() / 1000)
        const isExpiredSoon = hasValidPreview && isPreviewExpired(previewToUse, nowSeconds, 60)
        return { previewToUse, hasValidPreview, isExpiredSoon }
    }

    // Drop cooldown entries older than the 10s window — bounds the cache at ~10
    // entries worst case even across long-running sessions.
    const pruneCooldownCache = () => {
        const now = Date.now()
        const cache = audioPrefetchRef.current
        for (const key in cache) {
            if (now - cache[key] > 10_000) delete cache[key]
        }
    }

    const prefetchSongPreview = (song: SongItem, force: boolean = false): Promise<string | null> => {
        const { previewToUse, hasValidPreview, isExpiredSoon } = getPreviewStatus(song)
        if (hasValidPreview && !isExpiredSoon) return Promise.resolve(previewToUse || null)

        const prefetchKey = song.id || song.spotify_uri || previewToUse
        if (!prefetchKey) return Promise.resolve(null)

        const existing = audioPrefetchPromisesRef.current[prefetchKey]
        if (existing) return existing

        const lastPrefetchAt = audioPrefetchRef.current[prefetchKey] || 0
        if (!force && Date.now() - lastPrefetchAt < 10000) return Promise.resolve(null)

        if (audioPrefetchInFlightRef.current[prefetchKey]) {
            return audioPrefetchPromisesRef.current[prefetchKey] || Promise.resolve(null)
        }

        audioPrefetchInFlightRef.current[prefetchKey] = true
        audioPrefetchRef.current[prefetchKey] = Date.now()

        const p = resolvePreviewForSong(song)
            .then((newUrl) => {
                if (newUrl && song.id) {
                    audioPreviewOverrideRef.current[song.id] = newUrl
                }
                return newUrl || null
            })
            .catch((e) => {
                console.error('[Audio] Prefetch failed:', e)
                return null
            })
            .finally(() => {
                // `delete` rather than assign-null/false so caches don't grow
                // unbounded over long games (100+ rounds). audioPrefetchRef is
                // kept (acts as a 10s cooldown timestamp) but pruned below.
                delete audioPrefetchInFlightRef.current[prefetchKey]
                delete audioPrefetchPromisesRef.current[prefetchKey]
                pruneCooldownCache()
            })

        audioPrefetchPromisesRef.current[prefetchKey] = p
        return p
    }

    const isResolutionInFlight = (songId: string): boolean => {
        return !!audioPrefetchInFlightRef.current[songId]
    }

    return {
        // Accessors
        resolvePreviewForSong,
        getPreviewStatus,
        prefetchSongPreview,
        isPreviewExpired,
        isResolutionInFlight,
        // Refs exposed so consumers (e.g. error handlers, audio `src` management)
        // can share the override cache without routing through the resolver.
        audioPreviewOverrideRef,
    }
}
