# Playlist Import & Preview Logic

This document outlines the current flow of how the application transforms a Spotify/YouTube playlist link into playable iTunes audio previews, and identifies the flaws causing the "No verified match" and "CORS" errors.

## The Current Workflow

### 1. Input Handling (`src/lib/spotify.ts`)
The user pastes a URL. The system detects the source:
- **Spotify**: `spotify.com`
- **YouTube**: `youtube.com`
- **Text Search**: Anything else

### 2. Fetching Metadata (Server-Side)
This part works correctly. We contact our own API to get a list of "Raw Tracks" (Artist + Song Name).
- **Spotify**: Calls `POST /api/playlist`. Uses `spotify-url-info` or similar to scrape tracklists.
- **YouTube**: Calls `GET /api/youtube-playlist`. Uses `ytdl-core` or similar to get video titles.
- **Result**: A list of ~50-100 items like `{ artist: "Drake", name: "God's Plan" }`.

### 3. iTunes Resolution (Client-Side) **[CRITICAL FLAW]**
This is where the system is failing. The browser (client) takes this list and attempts to find playable audio for *every single track* individually.

```typescript
// Pseudo-code of current loop running in Browser
promises = metadata.map(async (track) => {
    // 1. Construct Query: "Drake God's Plan"
    // 2. Client-Side Fetch to Apple
    response = await fetch(`https://itunes.apple.com/search?term=Drake+Gods+Plan...`)
    
    // 3. Filter Results
    match = findMatch(response, track.artist, track.name)
    return match ? match.previewUrl : null
})
```

## identified Flaws

### 1. CORS Blocking (The Red Errors)
**The Error**: `Access to fetch at ... from origin 'http://localhost:3000' has been blocked by CORS policy`.
**The Cause**: The iTunes API (`itunes.apple.com`) does not officially support calls directly from a browser web page. It expects calls from a **Server**.
- Sometimes it works randomly.
- Most of the time, the browser blocks it for security.
- **Result**: The fetch fails immediately, returning `ERR_FAILED`. The code interprets this as "No match found" or just crashes the loop.

### 2. Client-Side Rate Limiting
**The Cause**: We fire ~100 requests *simultaneously* from the user's browser to Apple.
**The Effect**: Apple (or the user's network) treats this as spam/bot behavior and drops connections.

### 3. Strict Matching Logic
**The Issue**: Even if the fetch succeeds, our matching logic (`isMatch`) is strict.
- If Spotify says: "Glimpse of Us"
- iTunes says: "Glimpse of Us (feat. Joji)"
- The match might fail if strictness is too high.

## The Solution

To fix this reliably, we must **move the iTunes Resolution to the Server**.

1.  **Create `/api/resolve-tracks`**: A new API endpoint.
2.  **The Flow**:
    -   Client sends the list of `{ artist, name }` to this endpoint.
    -   **Server** (Node.js) makes the 100 requests to iTunes (Server-to-Server requests are not blocked by CORS).
    -   Server filters and returns the final list of valid previews.
3.  **Optimization**: The server can batch these requests or use a queue to avoid hitting rate limits.

This will eliminate the red console errors and significantly improve the "Found" rate.
