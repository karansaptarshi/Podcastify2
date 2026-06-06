import { useCallback, useEffect, useRef, useState } from 'react'

const PLAYBACK_RATES = [0.8, 1, 1.25, 1.5, 2]
const DEFAULT_PLAYBACK_RATE = 1.25

export function useContinuousPlayer() {
  const audioRef = useRef(null)
  const queueRef = useRef([])
  const currentIndexRef = useRef(-1)
  const hasStartedRef = useRef(false)
  const playbackRateRef = useRef(DEFAULT_PLAYBACK_RATE)

  const [isPlaying, setIsPlaying] = useState(false)
  const [isWaiting, setIsWaiting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  const [playbackRate, setPlaybackRate] = useState(DEFAULT_PLAYBACK_RATE)

  if (!audioRef.current) {
    audioRef.current = new Audio()
    audioRef.current.preload = 'auto'
    audioRef.current.playbackRate = DEFAULT_PLAYBACK_RATE
  }

  const playIndex = useCallback((index) => {
    const audio = audioRef.current
    const nextUrl = queueRef.current[index]

    if (!nextUrl) {
      setIsWaiting(true)
      setIsPlaying(false)
      return
    }

    currentIndexRef.current = index
    setProgress(0)
    setError(null)
    setIsWaiting(false)

    audio.src = nextUrl
    audio.currentTime = 0
    audio.playbackRate = playbackRateRef.current
    audio.play().catch(() => {
      setIsPlaying(false)
      setError('audio playback was blocked')
    })
  }, [])

  const start = useCallback(() => {
    const audio = audioRef.current
    hasStartedRef.current = true

    if (currentIndexRef.current === -1) {
      playIndex(0)
      return
    }

    if (!audio.src) {
      playIndex(currentIndexRef.current)
      return
    }

    setIsWaiting(false)
    audio.playbackRate = playbackRateRef.current
    audio.play().catch(() => {
      setIsPlaying(false)
      setError('audio playback was blocked')
    })
  }, [playIndex])

  const pause = useCallback(() => {
    audioRef.current.pause()
  }, [])

  const cyclePlaybackRate = useCallback(() => {
    setPlaybackRate((current) => {
      const currentIndex = PLAYBACK_RATES.indexOf(current)
      const next = PLAYBACK_RATES[((currentIndex === -1 ? 0 : currentIndex) + 1) % PLAYBACK_RATES.length]
      playbackRateRef.current = next
      audioRef.current.playbackRate = next
      return next
    })
  }, [])

  const addClip = useCallback((url) => {
    if (!url) return

    queueRef.current.push(url)

    const shouldResume =
      hasStartedRef.current &&
      (isWaiting || currentIndexRef.current === -1)

    if (shouldResume) {
      playIndex(currentIndexRef.current + 1)
    }
  }, [isWaiting, playIndex])

  useEffect(() => {
    playbackRateRef.current = playbackRate
    audioRef.current.playbackRate = playbackRate
  }, [playbackRate])

  useEffect(() => {
    const audio = audioRef.current

    const handlePlay = () => {
      setIsPlaying(true)
      setIsWaiting(false)
      setError(null)
    }

    const handlePause = () => {
      setIsPlaying(false)
    }

    const handleTimeUpdate = () => {
      if (!audio.duration || Number.isNaN(audio.duration)) {
        setProgress(0)
        return
      }

      setProgress(Math.min(1, audio.currentTime / audio.duration))
    }

    const handleEnded = () => {
      setProgress(1)
      playIndex(currentIndexRef.current + 1)
    }

    const handleError = () => {
      setIsPlaying(false)
      setIsWaiting(false)
      setError('audio file could not be loaded')
    }

    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('error', handleError)

    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('error', handleError)
    }
  }, [playIndex])

  return {
    start,
    pause,
    addClip,
    cyclePlaybackRate,
    isPlaying,
    isWaiting,
    progress,
    playbackRate,
    error,
  }
}

export default useContinuousPlayer
