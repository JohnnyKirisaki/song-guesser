export const SOUNDS = {
    correct: '/sounds/correct.mp3',
    wrong: '/sounds/wrong.mp3',
    tick: '/sounds/tick.mp3',
    reveal: '/sounds/reveal.mp3',
    win: '/sounds/win.mp3'
}

class SoundManager {
    private method: 'html5' | 'web-audio' = 'html5'
    private audioCache: Record<string, HTMLAudioElement> = {}
    private volume: number = 0.5

    constructor() {
        if (typeof window !== 'undefined') {
            // Preload
            Object.values(SOUNDS).forEach(src => {
                const audio = new Audio(src)
                this.audioCache[src] = audio
            })
        }
    }

    setVolume(v: number) {
        this.volume = Math.max(0, Math.min(1, v))
        Object.values(this.audioCache).forEach(audio => {
            audio.volume = this.volume
        })
    }

    play(key: keyof typeof SOUNDS) {
        if (typeof window === 'undefined') return
        const src = SOUNDS[key]
        const audio = this.audioCache[src] || new Audio(src)

        // Reset and play
        audio.currentTime = 0
        audio.volume = this.volume
        audio.play().catch(e => {
            // Ignored (user interaction usually required)
        })
    }
}

export const soundManager = new SoundManager()
