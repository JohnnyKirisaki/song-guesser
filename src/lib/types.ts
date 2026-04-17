// Shared cross-component types. Single source of truth for player shape,
// game-mode string literals, and room settings. Firebase stores these with
// fields sometimes missing, so non-identity fields are optional.

export type GameMode =
    | 'normal'
    | 'rapid'
    | 'artist_only'
    | 'song_only'
    | 'lyrics_only'
    | 'guess_who'
    | 'who_sang_that'
    | 'album_art'
    | 'chill_rating'
    | 'year_guesser'

export type RoomSettings = {
    rounds: number
    time: number
    mode: GameMode
    no_duplicates?: boolean
}

// One Player shape used across lobby, game, and recap. Only id/username/avatar
// and score are reliably present; the rest depend on lifecycle phase.
export type Player = {
    id: string
    username: string
    avatar_url: string
    score: number
    is_host?: boolean

    // Lobby
    is_ready?: boolean
    is_importing?: boolean
    import_progress?: number
    joined_at?: number
    playlist_name?: string | null
    playlist_cover_url?: string | null
    playlist_song_count?: number | null
    playlist_source_url?: string | null

    // Spectator — joined to watch, not score. Gated at both input UI and
    // server-side scoring so malicious clients can't flip the flag mid-game.
    is_spectator?: boolean

    // Disconnect-grace state. `last_seen` is bumped client-side every ~15s
    // and on every mount; `disconnected_at` is set by an onDisconnect handler
    // so we can tell "cleanly left" (immediate remove) from "network blip"
    // (60s grace, then reap on next lifecycle event).
    last_seen?: number | string | null
    disconnected_at?: number | string | null

    // In-game
    has_submitted?: boolean
    submitted_at?: number | string | null
    last_guess?: { artist: string; title: string }
    last_round_points?: number
    last_round_correct_title?: boolean
    last_round_correct_artist?: boolean
    last_round_time_taken?: number
    last_round_index?: number

    // Sudden death
    sudden_death_score?: number
}

// --- Runtime validators for Firebase snapshots ---
// These are lightweight shape checks, not full schemas. They catch the common
// failure modes (null, wrong type, missing required id) without pulling in Zod.

export function isValidSongItem(v: unknown): v is { id: string; artist_name: string; track_name: string } {
    if (!v || typeof v !== 'object') return false
    const s = v as Record<string, unknown>
    return typeof s.id === 'string'
        && s.id.length > 0
        && typeof s.artist_name === 'string'
        && typeof s.track_name === 'string'
}

export function isValidGameState(v: unknown): boolean {
    if (!v || typeof v !== 'object') return false
    const g = v as Record<string, unknown>
    return Array.isArray(g.playlist) && typeof g.phase === 'string'
}

