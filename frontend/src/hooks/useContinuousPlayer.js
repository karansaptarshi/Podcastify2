import { useCallback, useEffect, useRef, useState } from 'react'

export function useContinuousPlayer() {
  const audioRef = useRef(null)
  const queueRef = useRef([])
  const currentIndexRef = useRef(-1)
  const hasStartedRef = useRef(false)

  const [isPlaying, setIsPlaying] = useState(false)
  const [isWaiting, setIsWaiting] = useState(false)
  const [progress, setProgress] = useState(0)

  if (!audioRef.current) {
    audioRef.current = new Audio()
    audioRef.current.preload = 'auto'
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
    setIsWaiting(false)

    audio.src = nextUrl
    audio.currentTime = 0
    audio.play().catch(() => {
      setIsPlaying(false)
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
    audio.play().catch(() => {
      setIsPlaying(false)
    })
  }, [playIndex])

  const pause = useCallback(() => {
    audioRef.current.pause()
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
    const audio = audioRef.current

    const handlePlay = () => {
      setIsPlaying(true)
      setIsWaiting(false)
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

    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('ended', handleEnded)

    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('ended', handleEnded)
    }
  }, [playIndex])

  return {
    start,
    pause,
    addClip,
    isPlaying,
    isWaiting,
    progress,
  }
}

export default useContinuousPlayer
