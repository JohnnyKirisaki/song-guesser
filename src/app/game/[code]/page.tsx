'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useUser } from '@/context/UserContext'
import { GameState, SongItem } from '@/lib/game-logic'
import { Music, Volume2 } from 'lucide-react'
import ProgressBar from '@/components/ProgressBar'
import { calculateScore } from '@/lib/scoring'
import Podium from '@/components/Podium'
import { soundManager } from '@/lib/sounds'
import EmoteBar from '@/components/EmoteBar'
import Onboarding from '@/components/Onboarding'
import GameRecap from '@/components/GameRecap'

export default function GamePage() {
    const params = useParams()
    const code = params.code as string
    const { profile } = useUser()
    const router = useRouter()

    const [gameState, setGameState] = useState<GameState | null>(null)
    const [roomSettings, setRoomSettings] = useState<any>(null)
    const [status, setStatus] = useState('playing')
    const [timeLeft, setTimeLeft] = useState(-1) // -1 means "not started yet"
    const [isPlaying, setIsPlaying] = useState(false)
    const [guess, setGuess] = useState({ artist: '', title: '' })
    const [hasSubmitted, setHasSubmitted] = useState(false)
    const [roundResult, setRoundResult] = useState<{ points: number, message: string } | null>(null)
    const [totalScore, setTotalScore] = useState(0)
    const [pendingPoints, setPendingPoints] = useState(0) // Points calculated but not yet revealed
    const [players, setPlayers] = useState<any[]>([]) // Add players state
    const [pendingStats, setPendingStats] = useState<{ isCorrect: boolean, timeTaken: number } | null>(null)
    const [lyrics, setLyrics] = useState<string | null>(null)
    const [roundResults, setRoundResults] = useState<any[]>([])
    const previousScoresRef = useRef<Record<string, number>>({})

    const audioRef = useRef<HTMLAudioElement | null>(null)
    const processedPhaseRef = useRef<string | null>(null)
    const previousRoundIndexRef = useRef<number | null>(null)
    const latestGuessRef = useRef({ artist: '', title: '' })
    const submittedRoundRef = useRef<number | null>(null)
    const revealTriggeredRoundRef = useRef<number | null>(null)

    // Wait for profile AFTER hooks
    if (!profile) {
        return <Onboarding />
    }

    // Derived State
    const [hostId, setHostId] = useState<string>('')
    const isHost = profile?.id === hostId
    const currentSong = gameState?.playlist[gameState?.current_round_index || 0]
    const REVEAL_DURATION_MS = 6000
    const isArtistOnlyMode = roomSettings?.mode === 'artist_only'
    const isSongOnlyMode = roomSettings?.mode === 'song_only'
    const isLyricsOnlyMode = roomSettings?.mode === 'lyrics_only'

    useEffect(() => {
        latestGuessRef.current = guess
    }, [guess])

    const fetchPlayers = useCallback(async () => {
        const { data } = await supabase
            .from('room_players')
            .select('*, profile:profiles(username, avatar_url)')
            .eq('room_code', code)

        if (data) setPlayers(data as any[])
    }, [code])

    // 1. Initial Load & Subscriptions
    useEffect(() => {
        let channel: any

        const fetchGame = async () => {
            const { data } = await supabase.from('rooms').select('*').eq('code', code).single()
            if (!data) return router.push('/')

            setRoomSettings(data.settings)
            setGameState(data.game_state)
            setStatus(data.status)
            setHostId(data.host_id)

            await fetchPlayers()

            // Sync Timer
            if (data.game_state?.phase === 'playing' && data.game_state.round_start_time) {
                const elapsed = (Date.now() - new Date(data.game_state.round_start_time).getTime()) / 1000
                const remaining = Math.max(0, Math.ceil((data.settings.time || 15) - elapsed))
                setTimeLeft(remaining)
            }

            // RECONNECT PROTECTION: Restore player state
            if (profile) {
                const { data: p } = await supabase.from('room_players')
                    .select('has_submitted, score')
                    .eq('room_code', code)
                    .eq('user_id', profile.id)
                    .single()

                if (p) {
                    // Restore submission status
                    if (p.has_submitted && data.game_state?.phase === 'playing') {
                        setHasSubmitted(true)
                    }

                    // Restore total score
                    if (p.score > 0) {
                        setTotalScore(p.score)
                        console.log('[Game] Reconnected - Score restored:', p.score)
                    }

                    // Log reconnection if they were mid-game
                    if ((p.has_submitted || p.score > 0) && data.status === 'playing') {
                        console.log('[Game] ✅ Reconnection successful - State restored')
                    }
                }
            }
        }
        fetchGame()

        channel = supabase
            .channel(`game_${code}`)
            .on('postgres_changes', {
                event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${code}`
            }, (payload) => {
                const newState = payload.new.game_state as GameState
                const newStatus = payload.new.status
                setGameState(newState)
                setStatus(newStatus)
            })
            // Listen to player updates (for Host Auto-SKIP and Everyone's Score updates)
            .on('postgres_changes', {
                event: 'UPDATE', schema: 'public', table: 'room_players', filter: `room_code=eq.${code}`
            }, () => {
                fetchPlayers()
            })
            .subscribe((subscriptionStatus, error) => {
                console.log(`[Game] Subscription status: ${subscriptionStatus}`, error)
                if (subscriptionStatus === 'SUBSCRIBED') {
                    fetchGame()
                }
            })

        return () => {
            if (channel) supabase.removeChannel(channel)
        }
    }, [code, profile, fetchPlayers])

    // Fallback sync: rapid mode has faster transitions, so we poll room state in case realtime drops events.
    useEffect(() => {
        if (!code) return

        const interval = setInterval(async () => {
            const { data } = await supabase
                .from('rooms')
                .select('status, game_state, settings')
                .eq('code', code)
                .single()

            if (!data) return
            setStatus(data.status)
            setRoomSettings(data.settings)
            setGameState(data.game_state)
        }, 1500)

        return () => clearInterval(interval)
    }, [code])

    // Helper to setup VS Screen & Fetch Songs
    const triggerVsScreen = async (userIds: string[]) => {
        if (!gameState) return

        console.log('[Host] Triggering VS Screen for:', userIds)

        // Fetch All Songs
        let { data: allSongs } = await supabase.from('room_songs').select('*').eq('room_code', code)
        if (!allSongs) return

        const newPlaylist = [...gameState.playlist]
        const usedIds = new Set(newPlaylist.map(s => s.id))
        const suddenDeathSongs: SongItem[] = []

        // Helper to pick songs
        const pickSongs = (sourceSongs: any[]) => {
            userIds.forEach(uid => {
                const userSongs = sourceSongs.filter(s => s.picked_by_user_id === uid && !usedIds.has(s.id))
                // Only pick if we haven't picked enough for this user yet
                // For now, simple greedy pick
                const picks = userSongs.sort(() => 0.5 - Math.random()).slice(0, 2)
                suddenDeathSongs.push(...picks)
            })
        }

        // Attempt 1: Pick from existing
        pickSongs(allSongs)

        // If not enough (less than 1 per person), Try Fetch More
        if (suddenDeathSongs.length < userIds.length) {
            console.warn('[Host] Songs running low for Sudden Death. Fetching more from source...')
            try {
                const fetchRes = await fetch('/api/songs/fetch-more', {
                    method: 'POST',
                    body: JSON.stringify({ roomCode: code, userIds })
                })
                const fetchJson = await fetchRes.json()
                console.log('[Host] Fetched more result:', fetchJson)

                if (fetchJson.added > 0) {
                    // RE-FETCH from DB
                    const { data: refreshedSongs } = await supabase.from('room_songs').select('*').eq('room_code', code)
                    if (refreshedSongs) {
                        allSongs = refreshedSongs // Update local ref
                        // Try picking again from the FULL list (excluding used)
                        // Reset and re-pick to ensure balance? Or just append?
                        // Let's reset purely for simplicity of logic
                        suddenDeathSongs.length = 0
                        pickSongs(allSongs)
                    }
                }
            } catch (e) {
                console.error('[Host] Failed to fetch more songs:', e)
            }
        }

        // Final check
        if (suddenDeathSongs.length === 0) {
            console.error('[Host] CRITICAL: No songs available even after fetch attempt.')
            // Last Resort: Allow duplicates (Recycle)
            console.warn('[Host] Enabling recycle mode...')
            const recyclePool = allSongs.filter(s => userIds.includes(s.picked_by_user_id || ''))
            if (recyclePool.length > 0) {
                const recycled = recyclePool.sort(() => 0.5 - Math.random()).slice(0, 2)
                suddenDeathSongs.push(...recycled)
            } else {
                await supabase.from('rooms').update({ status: 'finished' }).eq('code', code)
                return
            }
        }

        // Shuffle adds
        newPlaylist.push(...suddenDeathSongs.sort(() => 0.5 - Math.random()))

        const newState = {
            ...gameState,
            playlist: newPlaylist,
            phase: 'vs_screen', // Trigger UI
            current_round_index: gameState.current_round_index, // Don't advance index yet, Phase change handles UI
            // Actually, we need to ensure the Next Round *starts* after this.
            // Current index was valid for the ENDED round.
            // The Play phase needs the index to point to the NEW song.
            // So we should verify where nextIdx is pointing.
            // existing 'nextIdx' passed to logic was current + 1. 
            // We should use that? No, vs_screen is an intermission.
            // The 'playing' phase later should pick up at current_round_index if we didn't advance it?
            // Wait, we appended songs. We need to point to the first new song.
            // If current was 9 (10th song). Next is 10.
            // We append 4 songs (indices 10, 11, 12, 13).
            // So safe to set index to nextIdx (passed from caller? No, we need it here).
            // Let's use gameState.playlist.length (before push) === nextIdx.
        }
        // Correction: We must update 'current_round_index' to the *first* of the new songs?
        // Or keep it pointing to "next".
        // Let's passed 'nextIdx' isn't available in this scope easily without arg.
        // But we know 'newPlaylist' is larger. The previous length was the boundary.
        // Actually, we don't want to increment index here if we haven't played it.
        // Let's just update playlist and phase. The 'vs_screen' logic will transition to 'playing'.
        // When transitioning to 'playing', does it increment? 
        // No, the timeout in vs_screen sets phase='playing'. It doesn't change index.
        // So we MUST ensure `current_round_index` is correct for the first sudden death song.
        // The previous round was `current_round_index`. We are now at `current + 1`.
        // So we should set `current_round_index` to `gameState.playlist.length` (original length) which matches `nextIdx`.

        newState.current_round_index = gameState.playlist.length
        newState.is_sudden_death = true
        newState.dueling_player_ids = userIds

        const { error } = await supabase.from('rooms').update({ game_state: newState }).eq('code', code)
        if (!error) {
            setGameState(newState as GameState)
        }
    }

    // 2. Audio Management (Robust & Persistent)
    // Separate cleanup to avoid stopping audio on every render/phase change
    useEffect(() => {
        return () => {
            if (audioRef.current) {
                audioRef.current.pause()
                audioRef.current = null
            }
        }
    }, [])

    useEffect(() => {
        const stopAudio = () => {
            if (audioRef.current) {
                audioRef.current.pause()
            }
        }

        if (!gameState || !currentSong) {
            stopAudio()
            return
        }

        const url = currentSong.preview_url
        const shouldPlay = (gameState.phase === 'playing' || gameState.phase === 'reveal')
        const isLyricsMode = isLyricsOnlyMode
        console.log(`[Audio] Sync: phase=${gameState.phase}, shouldPlay=${shouldPlay}, mode=${roomSettings?.mode}, url=${url ? 'EXISTS' : 'NULL'}, songId=${currentSong?.id}`)

        if (isLyricsMode) {
            console.log('[Audio] Lyrics mode active, skipping music playback.')
            stopAudio()
            return
        }

        if (url) {
            if (!audioRef.current || audioRef.current.src !== url) {
                console.log('[Audio] Initializing new Audio object')
                if (audioRef.current) audioRef.current.pause()
                audioRef.current = new Audio(url)
                audioRef.current.volume = 0.5
                audioRef.current.loop = true
            }

            if (shouldPlay) {
                if (audioRef.current.paused) {
                    console.log('[Audio] Triggering play()')
                    audioRef.current.play()
                        .then(() => {
                            setIsPlaying(true)
                            console.log('[Audio] Playback started successfully')
                        })
                        .catch(e => {
                            console.warn('[Audio] Playback failed/blocked:', e)
                            setIsPlaying(false)
                        })
                }
            } else {
                console.log('[Audio] Pausing (not in playing/reveal phase)')
                if (!audioRef.current.paused) {
                    audioRef.current.pause()
                    setIsPlaying(false)
                }
            }
        } else {
            console.warn('[Audio] No preview URL for current song')
        }

        // Reveal SFX (One-shot)
        if (gameState.phase === 'reveal') {
            // We don't stop the music, just overlay the sfx
            const reveal = new Audio('/sounds/reveal.mp3')
            reveal.volume = 0.6
            reveal.play().catch(() => { })
        }

        // Global interaction listener to "save" autoplay on first click
        const handleInteraction = () => {
            if (shouldPlay && audioRef.current && audioRef.current.paused) {
                audioRef.current.play()
                    .then(() => setIsPlaying(true))
                    .catch(() => { })
            }
        }
        window.addEventListener('click', handleInteraction)
        return () => window.removeEventListener('click', handleInteraction)
    }, [gameState?.phase, currentSong?.preview_url, isLyricsOnlyMode])

    // Lyrics mode: fetch and show first lines for the active song
    useEffect(() => {
        const fetchLyrics = async () => {
            if (!currentSong) return
            setLyrics('Loading...')
            try {
                console.log(`[Lyrics] Fetching lyrics for: ${currentSong.artist_name} - ${currentSong.track_name}`)
                const res = await fetch(`/api/lyrics?artist=${encodeURIComponent(currentSong.artist_name)}&title=${encodeURIComponent(currentSong.track_name)}`)
                const data = await res.json()
                const fetchedLyrics = data?.lyrics || 'Lyrics unavailable for this song.'
                console.log('[Lyrics] Fetch result:', {
                    songId: currentSong.id,
                    artist: currentSong.artist_name,
                    title: currentSong.track_name,
                    hasLyrics: Boolean(data?.lyrics),
                    preview: data?.lyrics ? String(data.lyrics).split('\n').slice(0, 2).join(' / ') : null
                })
                setLyrics(fetchedLyrics)
                if (data?.lyrics) {
                    console.log(`[Lyrics] Current Round Lyric: "${fetchedLyrics.replace(/\n/g, ' / ')}"`)
                }
            } catch {
                console.warn(`[Lyrics] Fetch failed for: ${currentSong.artist_name} - ${currentSong.track_name}`)
                setLyrics('Lyrics unavailable for this song.')
            }
        }

        if (isLyricsOnlyMode && currentSong) {
            // Fetch as soon as the song changes (even in 'starting' or 'vs_screen') so it's ready for 'playing'
            // But only if we haven't fetched for this song yet
            fetchLyrics()
        } else {
            setLyrics(null)
        }
    }, [currentSong?.id, isLyricsOnlyMode]) // Removed phase dependency to allow pre-fetching

    // Keep local score in sync with authoritative DB score updates
    useEffect(() => {
        if (!profile) return
        const me = players.find(p => p.user_id === profile.id)
        if (me) setTotalScore(me.score || 0)
    }, [players, profile])

    // 3. Round Results
    useEffect(() => {
        if (gameState?.phase === 'reveal' && currentSong) {
            const fetchRoundResults = async () => {
                const { data: guesses } = await supabase
                    .from('room_guesses')
                    .select('user_id, is_correct, time_taken')
                    .eq('room_code', code)
                    .eq('song_id', currentSong.id)

                const results = players.map(player => {
                    const guess = guesses?.find(g => g.user_id === player.user_id)
                    const previousScore = previousScoresRef.current[player.user_id] || 0
                    const points = Math.max(0, (player.score || 0) - previousScore)

                    return {
                        ...player,
                        guessResult: guess || { is_correct: false, time_taken: 0 },
                        points
                    }
                })

                setRoundResults(results)
            }

            fetchRoundResults()

            const interval = setInterval(fetchRoundResults, 500)
            return () => clearInterval(interval)
        } else {
            setRoundResults([])
        }
    }, [gameState?.phase, currentSong?.id, players, code])

    // Timer Local Tick (Previous logic)
    useEffect(() => {
        // Reset timer when phase changes to playing
        if (gameState?.phase === 'playing') {
            // Only set time left if we just entered this phase?
            // For simplicity, we keep timeLeft in sync with a local decrement only when playing.
            // But we need to know WHEN the round started to be accurate.
            // For now, assume simplified: Client just counts down from max.
            if (timeLeft === 0 && !hasSubmitted) {
                // Determine if we should reset? 
                // We'll reset timeLeft via a separate useEffect that watches round_index/phase
            }
        }
    }, [gameState?.phase])

    // SERVER-SIDE TIMER: Calculate from round_start_time instead of local countdown
    useEffect(() => {
        if (gameState?.phase === 'playing' && gameState?.round_start_time) {
            // Calculate time remaining based on server timestamp
            const updateTimer = () => {
                const elapsed = (Date.now() - new Date(gameState.round_start_time!).getTime()) / 1000
                const remaining = Math.max(0, Math.ceil((roomSettings?.time || 15) - elapsed))
                setTimeLeft(remaining)

            }

            // Initial update
            updateTimer()

            // Update every 100ms for smooth countdown (will still be accurate to server time)
            const interval = setInterval(updateTimer, 100)

            return () => clearInterval(interval)
        } else if (gameState?.phase !== 'playing') {
            // Not in playing phase, reset timer display
            setTimeLeft(roomSettings?.time || 15)
        }
    }, [gameState?.phase, gameState?.round_start_time, gameState?.current_round_index, roomSettings?.time])

    // Reset UI state only when advancing to a new round (not on first load/reconnect)
    useEffect(() => {
        if (!gameState) return

        const currentIndex = gameState.current_round_index
        if (previousRoundIndexRef.current === null) {
            previousRoundIndexRef.current = currentIndex
            return
        }

        if (gameState.phase === 'playing' && currentIndex !== previousRoundIndexRef.current) {
            setGuess({ artist: '', title: '' })
            setRoundResult(null)
            setPendingPoints(0)
            setPendingStats(null)
            setHasSubmitted(false)
            setRoundResults([])
            submittedRoundRef.current = null
            revealTriggeredRoundRef.current = null
        }

        // Extra safeguard: Force reset if entering VS Screen (interstitial)
        if (gameState.phase === 'vs_screen') {
            setHasSubmitted(false)
            setGuess({ artist: '', title: '' })
            setRoundResult(null)
            setPendingPoints(0)
            setRoundResults([])
            submittedRoundRef.current = null
            // CRITICAL: Reset this so the VS screen timer can fire again in Sudden Death
            processedPhaseRef.current = null
        }

        previousRoundIndexRef.current = currentIndex
    }, [gameState?.current_round_index, gameState?.phase])

    // Snapshot scores at the start of each playable round for reveal delta calculation
    useEffect(() => {
        if (gameState?.phase !== 'playing') return
        previousScoresRef.current = players.reduce((acc, player) => {
            acc[player.user_id] = player.score || 0
            return acc
        }, {} as Record<string, number>)
    }, [gameState?.phase, gameState?.current_round_index, players])


    // 4. HOST LOGIC: Game Loop & Auto-Skip
    useEffect(() => {
        // Only Host runs this to advance the server state
        if (!isHost || !gameState || !roomSettings) return

        let failsafeTimer: NodeJS.Timeout | null = null
        let transitionTimer: NodeJS.Timeout | null = null

        // Auto-Skip Logic: Check if everyone submitted
        const checkAutoSkip = async () => {
            if (gameState.phase !== 'playing' || timeLeft <= 3) return

            const { data: players } = await supabase.from('room_players').select('has_submitted').eq('room_code', code)
            if (players && players.length > 0 && players.every(p => p.has_submitted)) {
                console.log('[Host] All players submitted - Fast forwarding to 3s...')

                // Update server timestamp to make 3s remain
                const maxTime = roomSettings?.time || 15
                const newStartTime = new Date(Date.now() - (maxTime - 3) * 1000).toISOString()

                await supabase.from('rooms').update({
                    game_state: {
                        ...gameState,
                        round_start_time: newStartTime
                    }
                }).eq('code', code)
            }
        }

        // Run Auto-Skip check periodically (every 1s for responsiveness)
        const autoSkipInterval = setInterval(checkAutoSkip, 1000)

        if (gameState.phase === 'playing') {
            // FAILSAFE: If timer doesn't tick down properly, force reveal after max time + buffer
            const maxTime = (roomSettings.time || 15) + 3 // 3 second buffer
            failsafeTimer = setTimeout(async () => {
                console.warn('[Host] Failsafe triggered - forcing reveal phase')
                const newState = { ...gameState, phase: 'reveal' as const }
                const { error } = await supabase.from('rooms').update({ game_state: newState }).eq('code', code)
                if (!error) {
                    setGameState(newState as GameState)
                }
            }, maxTime * 1000)

            // Transition immediately at time up
            // Check if we are still in playing phase and time is up
            if (timeLeft <= 0 && gameState.phase === 'playing') {
                // Throttle: Ensure we haven't triggered this round index recently
                if (revealTriggeredRoundRef.current !== gameState.current_round_index) {
                    console.log('[Host] Time up! Triggering Reveal Phase...')
                    revealTriggeredRoundRef.current = gameState.current_round_index

                    // Clear failsafe since we're handling it now
                    if (failsafeTimer) clearTimeout(failsafeTimer)

                    const newState = { ...gameState, phase: 'reveal' as const }

                    // Run update
                    supabase.from('rooms').update({ game_state: newState }).eq('code', code)
                        .then(({ error }) => {
                            if (error) console.error('[Host] Failed to transition to reveal:', error)
                            else {
                                setGameState(newState as GameState)
                                // Reset submissions
                                supabase.from('room_players').update({ has_submitted: false }).eq('room_code', code).then(() => { })
                            }
                        })
                }
            }
        } else if (gameState.phase === 'reveal') {
            // Host waits 5s then Next Round
            transitionTimer = setTimeout(async () => {
                const nextIdx = gameState.current_round_index + 1

                // END OF GAME / ROUND CHECK
                if (nextIdx >= gameState.playlist.length) {
                    // Check for Ties & Suddern Death Conditions
                    const { data: scores } = await supabase
                        .from('room_players')
                        .select('user_id, score, profile:profiles(username, avatar_url)')
                        .eq('room_code', code)
                        .order('score', { ascending: false })

                    if (!scores) return

                    // Check for active duel "Win by 2" condition
                    if (gameState.is_sudden_death && gameState.dueling_player_ids) {
                        const duelists = scores.filter(p => gameState.dueling_player_ids!.includes(p.user_id))
                        duelists.sort((a, b) => b.score - a.score) // Sort HIGH to LOW for clarity

                        if (duelists.length >= 2) {
                            // Top 2 scorers
                            const pHigh = duelists[0]  // Highest score
                            const pNext = duelists[1]  // Second highest
                            const diff = pHigh.score - pNext.score

                            if (diff >= 2) {
                                console.log('[Host] Duel resolved with diff:', diff)
                                // Fall through to check other ties or finish
                            } else {
                                console.log('[Host] Duel NOT resolved (Diff < 2). Extending...')
                                // RE-TRIGGER VS SCREEN FOR SAME PLAYERS
                                await triggerVsScreen(duelists.map(d => d.user_id))
                                return
                            }
                        }
                    }


                    // Scan for ANY ties (starting from top)
                    const scoreMap = new Map<number, string[]>()
                    scores.forEach(s => {
                        const list = scoreMap.get(s.score) || []
                        list.push(s.user_id)
                        scoreMap.set(s.score, list)
                    })

                    const sortedUniqueScores = Array.from(scoreMap.keys()).sort((a, b) => a - b) // Ascending (Low to High)
                    let tieGroupId: string[] | null = null

                    for (const s of sortedUniqueScores) {
                        const ids = scoreMap.get(s)
                        if (ids && ids.length > 1) {
                            tieGroupId = ids
                            break // Prioritize highest ranking tie
                        }
                    }

                    if (tieGroupId) {
                        console.log('[Host] Tie detected:', tieGroupId)
                        await triggerVsScreen(tieGroupId)
                        return
                    }

                    // No ties, game finished
                    await supabase.from('rooms').update({
                        status: 'finished',
                        finished_at: new Date().toISOString()
                    }).eq('code', code)

                } else {
                    // Normal Next Round
                    const nextPhase = gameState.is_sudden_death ? 'vs_screen' : 'playing'
                    const newState = {
                        ...gameState,
                        phase: nextPhase,
                        current_round_index: nextIdx,
                        round_start_time: new Date().toISOString()
                    }
                    const { error } = await supabase.from('rooms').update({ game_state: newState }).eq('code', code)
                    if (!error) {
                        setGameState(newState as GameState)
                    }
                }

            }, REVEAL_DURATION_MS)
        } else if (gameState.phase === 'vs_screen') {
            // Host waits 5s (displaying VS screen) then switches to playing
            if (processedPhaseRef.current !== 'vs_screen') {
                console.log('[Host] VS screen detected, will transition to playing in 6s')
                transitionTimer = setTimeout(async () => {
                    const newState = {
                        ...gameState,
                        phase: 'playing',
                        round_start_time: new Date().toISOString()
                    }
                    const { error } = await supabase.from('rooms').update({ game_state: newState }).eq('code', code)
                    if (!error) {
                        processedPhaseRef.current = 'vs_screen'
                        setGameState(newState as GameState)
                    }
                }, 6000)
            }
        } else if (gameState.phase === 'starting') {
            // Host waits 3s then starts playing
            if (processedPhaseRef.current !== 'starting') {
                console.log('[Host] Starting phase detected, will transition to playing in 3s')
                transitionTimer = setTimeout(async () => {
                    const newState = {
                        ...gameState,
                        phase: 'playing',
                        round_start_time: new Date().toISOString()
                    }
                    console.log('[Host] Executing transition to PLAYING...')
                    const { error } = await supabase.from('rooms').update({ game_state: newState }).eq('code', code)
                    if (error) console.error('[Host] Transition Error:', error)
                    else {
                        processedPhaseRef.current = 'starting'
                        setGameState(newState as GameState)
                        console.log('[Host] Transition SUCCESS')
                    }
                }, 3000)
            }
        } else {
            // Reset for playing/reveal so it can re-trigger on next round's vs_screen if needed
            // Actually, we should only reset if the phase IS different from what we processed
            if (processedPhaseRef.current !== gameState.phase) {
                processedPhaseRef.current = gameState.phase
            }
        }

        // Cleanup all timers
        return () => {
            if (failsafeTimer) clearTimeout(failsafeTimer)
            if (transitionTimer) clearTimeout(transitionTimer)
            clearInterval(autoSkipInterval)
        }

    }, [timeLeft, isHost, gameState?.phase, gameState?.current_round_index, REVEAL_DURATION_MS])


    // Actions
    const submitGuess = async (guessOverride?: { artist: string, title: string }) => {
        if (hasSubmitted || !gameState) return
        if (submittedRoundRef.current === gameState.current_round_index) return
        submittedRoundRef.current = gameState.current_round_index
        setHasSubmitted(true)

        // Play submit sound
        soundManager.play('tick') // Using 'tick' as 'submit' is missing

        // Haptic feedback (if supported)
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
            navigator.vibrate(50) // 50ms subtle vibration
        }

        // Calculate score but DON'T submit to DB yet - wait for reveal
        const lockedGuess = guessOverride ?? latestGuessRef.current
        const songParams = { artist: currentSong?.artist_name || '', title: currentSong?.track_name || '' }
        const result = calculateScore(lockedGuess, songParams, Math.max(0, timeLeft), roomSettings?.time || 15, roomSettings?.mode || 'normal')

        // Store pending points (will be added on reveal)
        setPendingPoints(result.points)
        setRoundResult({ points: result.points, message: `+${result.points} pts` })

        // Store pending stats for DB
        const timeTaken = (roomSettings?.time || 15) - timeLeft
        setPendingStats({ isCorrect: result.points > 0, timeTaken })

        // Persist "Submitted" status so we don't lose it on refresh AND Host knows we're done
        if (profile) {
            await supabase.from('room_players')
                .update({ has_submitted: true })
                .eq('room_code', code)
                .eq('user_id', profile.id)
        }
    }

    // When reveal phase starts, add pending points to total and submit to DB
    useEffect(() => {
        if (gameState?.phase === 'reveal' && pendingPoints > 0) {
            // Add to local total
            setTotalScore(prev => prev + pendingPoints)
        }

        // Logic that runs ONCE per reveal (checked via pendingStats or pendingPoints > 0 for score)
        // We use pendingStats to check if we need to commit data
        if (gameState?.phase === 'reveal' && pendingStats) {
            // Play sound
            if (pendingStats.isCorrect) soundManager.play('correct'); else soundManager.play('wrong');

            if (profile) {
                // Update Score
                if (pendingPoints > 0) {
                    (async () => {
                        const { data: p } = await supabase.from('room_players').select('score').eq('room_code', code).eq('user_id', profile.id).single()
                        if (p) {
                            await supabase.from('room_players').update({ score: p.score + pendingPoints }).eq('room_code', code).eq('user_id', profile.id)
                        }
                    })()
                }

                // Record Stats
                (async () => {
                    await supabase.from('room_guesses').insert({
                        room_code: code,
                        user_id: profile.id,
                        song_id: currentSong?.id,
                        is_correct: pendingStats.isCorrect,
                        time_taken: pendingStats.timeTaken
                    })
                })()
            }

            // Clear pending
            setPendingPoints(0)
            setPendingStats(null)
        }
    }, [gameState?.phase, pendingStats, pendingPoints, profile, code, currentSong?.id])

    // Timeout lock-in: when round flips to reveal, submit whatever was typed (if not manually submitted)
    useEffect(() => {
        if (!gameState) return
        if (gameState.phase !== 'reveal') return
        if (hasSubmitted) return
        submitGuess(latestGuessRef.current)
    }, [gameState?.phase, gameState?.current_round_index, hasSubmitted])



    if (status === 'finished') return <GameRecap roomCode={code} players={players} />
    if (!gameState || !currentSong) return <div className="flex-center" style={{ height: '100vh' }}>Loading...</div>

    // Calculate rankings with tie handling
    const getLeaderboard = () => {
        const sorted = [...players].sort((a, b) => b.score - a.score)
        const withRanks: any[] = []
        let currentRank = 1

        for (let i = 0; i < sorted.length; i++) {
            if (i > 0 && sorted[i].score < sorted[i - 1].score) {
                // Score is different from previous, update rank to current position
                currentRank = i + 1
            }
            withRanks.push({ ...sorted[i], rank: currentRank })
        }

        return withRanks
    }

    return (
        <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0a0a0a', color: 'white', position: 'relative', overflow: 'hidden' }}>

            {/* Audio Fallback Overlay */}
            {!isPlaying && (gameState?.phase === 'playing' || gameState?.phase === 'reveal') && !isLyricsOnlyMode && (
                <div
                    onClick={() => audioRef.current?.play().then(() => setIsPlaying(true))}
                    style={{
                        position: 'fixed', bottom: '30px', right: '30px', zIndex: 1000,
                        background: 'var(--primary)', color: 'black', padding: '12px 24px',
                        borderRadius: '50px', fontWeight: 'bold', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', gap: '10px',
                        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
                        animation: 'pulse 2s infinite'
                    }}
                >
                    <Volume2 size={20} />
                    <span>Click to Unmute Music</span>
                </div>
            )}

            {/* Audio plays automatically - no manual button */}

            {/* Live Leaderboard Sidebar (Left Middle) */}
            <div className="glass-panel" style={{
                position: 'fixed',
                top: '50%',
                left: '20px',
                transform: 'translateY(-50%)',
                width: '200px',
                padding: '16px',
                zIndex: 50,
                maxHeight: '400px',
                overflowY: 'auto'
            }}>
                <h4 style={{ fontSize: '0.9rem', marginBottom: '12px', textAlign: 'center', color: '#888', textTransform: 'uppercase', letterSpacing: '1px' }}>Leaderboard</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {getLeaderboard().map((player, idx) => (
                        <div
                            key={player.user_id}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '8px',
                                borderRadius: '8px',
                                background: player.user_id === profile.id ? 'rgba(30, 215, 96, 0.1)' : 'rgba(255,255,255,0.03)',
                                border: player.user_id === profile.id ? '1px solid var(--primary)' : '1px solid transparent',
                                transition: 'all 0.3s'
                            }}
                        >
                            <div style={{
                                width: '24px',
                                height: '24px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontWeight: 'bold',
                                fontSize: '0.75rem',
                                color: player.rank === 1 ? '#ffd700' : player.rank === 2 ? '#c0c0c0' : player.rank === 3 ? '#cd7f32' : '#888'
                            }}>
                                {player.rank === 1 ? '🥇' : player.rank === 2 ? '🥈' : player.rank === 3 ? '🥉' : `#${player.rank}`}
                            </div>
                            <img
                                src={player.profile.avatar_url}
                                style={{ width: '32px', height: '32px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.1)' }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: '0.85rem', fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {player.profile.username}
                                </div>
                                <div style={{ fontSize: '0.7rem', color: '#888' }}>
                                    {player.score} pts
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Top Stats */}
            <div style={{ padding: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: '1.2rem', color: '#888' }}>
                    Round <span style={{ color: 'white' }}>{gameState.current_round_index + 1}</span> / {gameState.playlist.length}
                </div>
                <div style={{ fontSize: '3rem', fontWeight: 900, fontVariantNumeric: 'tabular-nums', color: timeLeft <= 5 && timeLeft >= 0 ? '#ef4444' : 'white' }}>
                    {gameState.phase === 'playing'
                        ? (timeLeft >= 0 ? timeLeft : (roomSettings?.time || 15))
                        : gameState.phase === 'reveal'
                            ? 'REVEAL'
                            : gameState.phase === 'starting'
                                ? 'START'
                                : 'VS'}
                </div>
                <div style={{ fontSize: '1.2rem', color: '#888' }}>
                    Score: <span style={{ color: '#22c55e' }}>{totalScore}</span>
                </div>
            </div>
            {gameState.phase === 'playing' && <ProgressBar current={timeLeft} total={roomSettings?.time || 15} />}

            {/* Content */}
            <EmoteBar roomCode={code} />

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                {gameState.phase === 'starting' && (
                    <div className="glass-panel" style={{ padding: '40px 56px', textAlign: 'center', marginBottom: '48px' }}>
                        <h2 style={{ fontSize: '2rem', marginBottom: '8px' }}>Get Ready</h2>
                        <p style={{ color: '#aaa' }}>First song starts in a moment...</p>
                    </div>
                )}

                {gameState.phase === 'vs_screen' && (
                    <div className="animate-in" style={{
                        width: '100%', maxWidth: '800px',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '40px'
                    }}>
                        <h1 className="text-gradient" style={{ fontSize: '4rem', fontWeight: 900, marginBottom: '40px', letterSpacing: '4px' }}>
                            SUDDEN DEATH
                        </h1>

                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '80px', width: '100%' }}>
                            {(() => {
                                const duelists = players.filter(p => gameState.dueling_player_ids?.includes(p.user_id))
                                if (duelists.length < 2) return null
                                const [p1, p2] = duelists.sort((a, b) => b.score - a.score)
                                const diff = (p1.score || 0) - (p2.score || 0)
                                const p1Offset = Math.min(100, diff * 20)
                                const p2Offset = Math.max(-100, diff * -20)

                                const isDraw = diff === 0
                                const drawColor = '#888'

                                return (
                                    <>
                                        {/* Player 1 (Leader) */}
                                        <div style={{
                                            transform: `translateY(${-p1Offset}px)`,
                                            transition: 'transform 1s cubic-bezier(0.34, 1.56, 0.64, 1)',
                                            textAlign: 'center'
                                        }}>
                                            <div style={{
                                                width: '180px', height: '180px', borderRadius: '50%',
                                                border: `8px solid ${isDraw ? drawColor : '#FFD700'}`,
                                                boxShadow: `0 0 50px ${isDraw ? 'rgba(255,255,255,0.2)' : 'rgba(255, 215, 0, 0.6)'}`,
                                                overflow: 'hidden', margin: '0 auto 16px',
                                                transition: 'all 0.5s'
                                            }}>
                                                <img src={p1.profile.avatar_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                            </div>
                                            <h2 style={{ fontSize: '2rem', fontWeight: 800 }}>{p1.profile.username}</h2>
                                            <div style={{ fontSize: '3rem', fontWeight: 900, color: isDraw ? drawColor : '#FFD700' }}>{p1.score}</div>
                                            {diff > 0 && <div style={{ color: '#22c55e', fontWeight: 'bold' }}>+{diff} Lead</div>}
                                        </div>

                                        <div style={{ fontSize: '3rem', fontWeight: 900, color: '#666', fontStyle: 'italic' }}>VS</div>

                                        {/* Player 2 */}
                                        <div style={{
                                            transform: `translateY(${-p2Offset}px)`,
                                            transition: 'transform 1s cubic-bezier(0.34, 1.56, 0.64, 1)',
                                            textAlign: 'center'
                                        }}>
                                            <div style={{
                                                width: '150px', height: '150px', borderRadius: '50%',
                                                border: `6px solid ${isDraw ? drawColor : '#ef4444'}`,
                                                boxShadow: `0 0 30px ${isDraw ? 'rgba(255,255,255,0.2)' : 'rgba(239, 68, 68, 0.4)'}`,
                                                overflow: 'hidden', margin: '0 auto 16px',
                                                filter: isDraw ? 'none' : 'grayscale(0.3)',
                                                transition: 'all 0.5s'
                                            }}>
                                                <img src={p2.profile.avatar_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                            </div>
                                            <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#ccc' }}>{p2.profile.username}</h2>
                                            <div style={{ fontSize: '2.5rem', fontWeight: 900, color: isDraw ? drawColor : '#ef4444' }}>{p2.score}</div>
                                        </div>
                                    </>
                                )
                            })()}
                        </div>
                    </div>
                )}

                {/* Vinyl Record or Lyrics Display */}
                {(gameState.phase === 'playing' || gameState.phase === 'reveal') && (
                    isLyricsOnlyMode && gameState.phase === 'playing' ? (
                        <div className="glass-panel" style={{
                            width: '400px',
                            minHeight: '200px',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            marginBottom: '48px', padding: '32px', textAlign: 'center',
                            flexDirection: 'column',
                            background: 'rgba(0,0,0,0.6)',
                            backdropFilter: 'blur(12px)',
                            border: '1px solid rgba(255,255,255,0.1)'
                        }}>
                            <Music size={32} style={{ marginBottom: '24px', opacity: 0.5, color: 'var(--primary)' }} />
                            <div style={{
                                fontSize: '1.4rem',
                                lineHeight: '1.8',
                                whiteSpace: 'pre-wrap',
                                fontFamily: 'Georgia, serif',
                                fontStyle: 'italic',
                                color: '#eee',
                                textShadow: '0 2px 4px rgba(0,0,0,0.5)'
                            }}>
                                {lyrics || (
                                    <span style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '1rem', color: '#888' }}>
                                        Loading lyrics...
                                    </span>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className={`vinyl-container ${gameState.phase === 'playing' ? 'spinning' : ''}`} style={{ marginBottom: '48px', opacity: hasSubmitted ? 0.5 : 1, transition: 'opacity 0.3s' }}>
                            <div className="vinyl-record">
                                <div className="vinyl-grooves" />
                                <div className="vinyl-label" style={{
                                    backgroundImage: gameState.phase === 'reveal' ? `url(${currentSong.cover_url})` : 'none',
                                    backgroundColor: gameState.phase === 'reveal' ? 'transparent' : '#222',
                                    backgroundSize: 'cover',
                                    width: gameState.phase === 'reveal' ? '100%' : '140px',
                                    height: gameState.phase === 'reveal' ? '100%' : '140px',
                                    transition: 'all 0.5s ease'
                                }}>
                                    {gameState.phase === 'playing' && <div className="center-hole" />}
                                </div>
                            </div>
                        </div>
                    )
                )}

                {/* Question / Reveal */}
                {gameState.phase === 'reveal' && (
                    <div className="text-center animate-in fade-in zoom-in duration-500">
                        <h1 className="text-gradient" style={{ fontSize: '2.5rem', marginBottom: '8px' }}>{currentSong.track_name}</h1>
                        <h2 style={{ fontSize: '1.5rem', color: '#aaa' }}>{currentSong.artist_name}</h2>


                        {/* Picked By Label / This Was My Song */}
                        <div style={{ marginTop: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
                            {currentSong.picked_by_user_id === profile.id ? (
                                <div className="animate-in" style={{
                                    background: 'linear-gradient(135deg, #FFD700, #FFA500)',
                                    color: 'black',
                                    padding: '10px 28px',
                                    borderRadius: '50px',
                                    fontWeight: '900',
                                    fontSize: '1rem',
                                    textTransform: 'uppercase',
                                    boxShadow: '0 0 20px rgba(255, 215, 0, 0.5)',
                                    display: 'flex', alignItems: 'center', gap: '8px'
                                }}>
                                    <span>★ THIS WAS YOUR SONG! ★</span>
                                </div>
                            ) : (
                                <div style={{ fontSize: '0.9rem', color: '#666', display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.05)', padding: '8px 20px', borderRadius: '24px' }}>
                                    <span>Picked by</span>
                                    <span style={{ color: 'white', fontWeight: '600' }}>
                                        {players.find(p => p.user_id === currentSong.picked_by_user_id)?.profile?.username || 'Unknown'}
                                    </span>
                                    <img
                                        src={players.find(p => p.user_id === currentSong.picked_by_user_id)?.profile?.avatar_url}
                                        style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.2)' }}
                                    />
                                </div>
                            )}
                        </div>


                        {roundResult && <div style={{ marginTop: '24px', fontSize: '1.5rem', color: roundResult.points > 0 ? '#22c55e' : '#ef4444' }}>{roundResult.message}</div>}
                    </div>
                )}

                {/* Round Results - All Players */}
                {gameState.phase === 'reveal' && roundResults.length > 0 && (
                    <div style={{ width: '100%', maxWidth: '600px', marginTop: '32px' }}>
                        <h3 style={{ textAlign: 'center', marginBottom: '16px', fontSize: '1.2rem', color: '#888' }}>Round Results</h3>
                        <div style={{ display: 'grid', gap: '8px' }}>
                            {[...roundResults]
                                .sort((a, b) => (b.points || 0) - (a.points || 0))
                                .map((result) => (
                                    <div
                                        key={result.user_id}
                                        className="glass-panel animate-in"
                                        style={{
                                            padding: '12px 16px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            border: result.user_id === profile.id ? '2px solid var(--primary)' : '1px solid rgba(255,255,255,0.1)',
                                            background: result.guessResult.is_correct ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)'
                                        }}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                            <img
                                                src={result.profile.avatar_url}
                                                style={{ width: '40px', height: '40px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.2)' }}
                                            />
                                            <div>
                                                <div style={{ fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                    {result.profile.username}
                                                    {result.user_id === profile.id && <span style={{ fontSize: '0.7rem', color: 'var(--primary)' }}>(You)</span>}
                                                </div>
                                                {result.guessResult.is_correct && (
                                                    <div style={{ fontSize: '0.75rem', color: '#888' }}>
                                                        {result.guessResult.time_taken}s
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                            {result.guessResult.is_correct ? (
                                                <>
                                                    <span style={{ fontSize: '1.3rem' }}>✅</span>
                                                    <span style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#22c55e' }}>
                                                        +{result.points}
                                                    </span>
                                                </>
                                            ) : (
                                                <>
                                                    <span style={{ fontSize: '1.3rem' }}>❌</span>
                                                    <span style={{ fontSize: '1rem', color: '#888' }}>0</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                ))}
                        </div>
                    </div>
                )}

                {/* Inputs */}
                {gameState.phase === 'playing' && !hasSubmitted && (
                    <div style={{ width: '100%', maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: '12px', padding: '0 20px' }}>
                        {!isArtistOnlyMode && (
                            <input
                                placeholder="Song Title"
                                className="game-input"
                                value={guess.title}
                                onChange={e => setGuess({ ...guess, title: e.target.value })}
                                autoFocus={!isArtistOnlyMode}
                                onKeyDown={e => {
                                    if (e.key !== 'Enter') return
                                    if (isSongOnlyMode) submitGuess()
                                    else document.getElementById('artist-input')?.focus()
                                }}
                            />
                        )}
                        {!isSongOnlyMode && (
                            <input
                                id="artist-input"
                                placeholder="Artist Name"
                                className="game-input"
                                value={guess.artist}
                                onChange={e => setGuess({ ...guess, artist: e.target.value })}
                                autoFocus={isArtistOnlyMode}
                                onKeyDown={e => e.key === 'Enter' && submitGuess()}
                            />
                        )}
                        <button className="btn-primary" onClick={() => submitGuess()} style={{ padding: '16px' }}>SUBMIT</button>
                    </div>
                )}

                {hasSubmitted && gameState.phase === 'playing' && (
                    <div className="glass-panel" style={{ padding: '24px', textAlign: 'center' }}>
                        <h3>Guess Locked In! 🔒</h3>
                        <p style={{ color: '#888' }}>Waiting for time up...</p>
                    </div>
                )}
            </div>

            <style jsx global>{`
                .game-input {
                    background: rgba(255,255,255,0.08);
                    border: 1px solid rgba(255,255,255,0.1);
                    padding: 16px;
                    border-radius: 12px;
                    color: white;
                    font-size: 1.1rem;
                    outline: none;
                    transition: all 0.2s;
                }
                .game-input:focus {
                    background: rgba(255,255,255,0.12);
                    border-color: var(--primary);
                }
                .vinyl-container {
                    width: 350px; height: 350px;
                    position: relative;
                    filter: drop-shadow(0 20px 40px rgba(0,0,0,0.6));
                }
                .vinyl-record {
                    width: 100%; height: 100%;
                    background: #111;
                    border-radius: 50%;
                    position: relative;
                    background: repeating-radial-gradient(
                      #111 0, 
                      #111 2px, 
                      #222 3px, 
                      #222 4px
                    );
                }
                .vinyl-label {
                    position: absolute;
                    top: 50%; left: 50%;
                    transform: translate(-50%, -50%);
                    width: 100px; height: 100px;
                    background: var(--primary);
                    border-radius: 50%;
                    border: 4px solid rgba(0,0,0,0.2);
                }
                .center-hole {
                    width: 12px; height: 12px;
                    background: #0a0a0a;
                    border-radius: 50%;
                    position: absolute;
                    top: 50%; left: 50%;
                    transform: translate(-50%, -50%);
                }
                .spinning { animation: spin 4s linear infinite; }
                @keyframes spin { 100% { transform: rotate(360deg); } }
                @keyframes pulse {
                    0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(30, 215, 96, 0.4); }
                    70% { transform: scale(1.05); box-shadow: 0 0 0 15px rgba(30, 215, 96, 0); }
                    100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(30, 215, 96, 0); }
                }
            `}</style>
        </div>
    )
}
