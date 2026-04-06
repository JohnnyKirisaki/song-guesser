export const SOUNDS = {
    correct: '/sounds/correct.mp3',
    wrong: '/sounds/wrong.mp3',
    tick: '/sounds/tick.mp3',
    reveal: '/sounds/reveal.mp3',
    win: '/sounds/win.mp3',
    countdown_tick: '/sounds/countdown_tick.mp3',
    sudden_death: '/sounds/sudden_death.mp3',
    all_ready: '/sounds/all_ready.mp3'
}

class SoundManager {
    private audioCache: Record<string, HTMLAudioElement> = {}
    private volume: number = 0.5
    private volumeOverrides: Partial<Record<keyof typeof SOUNDS, number>> = {
        tick: 0.5,
        countdown_tick: 0.3
    }

    constructor() {
        if (typeof window !== 'undefined') {
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

        const override = this.volumeOverrides[key] ?? 1
        audio.currentTime = 0
        audio.volume = this.volume * override
        audio.play().catch(() => {})
    }

    stop(key: keyof typeof SOUNDS) {
        const src = SOUNDS[key]
        const audio = this.audioCache[src]
        if (audio) {
            audio.pause()
            audio.currentTime = 0
        }
    }
}

export const soundManager = new SoundManager()
