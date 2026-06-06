import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import useContinuousPlayer from '../hooks/useContinuousPlayer'

const PodcastPlayer = forwardRef(function PodcastPlayer({
  hookUrl,
  clipUrls = [],
  isPreparing = false,
  error = null,
  autoStart = false,
}, ref) {
  const player = useContinuousPlayer()
  const addedClipUrlsRef = useRef(new Set())
  const autoStartedHookUrlRef = useRef(null)

  useImperativeHandle(ref, () => ({
    addClip: player.addClip,
    start: player.start,
    pause: player.pause,
  }), [player.addClip, player.pause, player.start])

  useEffect(() => {
    const urls = clipUrls.length ? clipUrls : hookUrl ? [hookUrl] : []

    urls.forEach((url) => {
      if (!url || addedClipUrlsRef.current.has(url)) return

      player.addClip(url)
      addedClipUrlsRef.current.add(url)
    })
  }, [clipUrls, hookUrl, player])

  useEffect(() => {
    const firstUrl = clipUrls[0] || hookUrl
    if (!autoStart || !firstUrl || autoStartedHookUrlRef.current === firstUrl) return

    autoStartedHookUrlRef.current = firstUrl
    player.start()
  }, [autoStart, clipUrls, hookUrl, player])

  const togglePlayback = () => {
    if (!hookUrl && !clipUrls.length && isPreparing) return

    if (player.isPlaying) {
      player.pause()
      return
    }

    player.start()
  }

  return (
    <div style={styles.shell}>
      <button
        type="button"
        onClick={togglePlayback}
        disabled={!hookUrl && !clipUrls.length && isPreparing}
        style={{
          ...styles.button,
          ...(!hookUrl && !clipUrls.length && isPreparing ? styles.buttonDisabled : null),
        }}
      >
        {!hookUrl && !clipUrls.length && isPreparing ? 'Getting ready...' : player.isPlaying ? 'Pause' : 'Play'}
      </button>

      <button
        type="button"
        onClick={player.cyclePlaybackRate}
        style={styles.speedButton}
        title="Playback speed"
        aria-label="Playback speed"
      >
        {player.playbackRate}x
      </button>

      <div style={styles.progressTrack} aria-label="Current clip progress">
        <div style={{ ...styles.progressFill, width: `${player.progress * 100}%` }} />
      </div>

      <div style={styles.status}>
        {error || player.error || (!hookUrl && !clipUrls.length && isPreparing ? 'preparing audio...' : player.isWaiting ? 'loading next...' : player.isPlaying ? 'playing intro' : 'ready')}
      </div>
    </div>
  )
})

const styles = {
  shell: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    width: '100%',
    maxWidth: '640px',
    padding: '14px 16px',
    borderRadius: '16px',
    background: 'rgba(12, 12, 18, 0.78)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    color: '#fff',
  },
  button: {
    minWidth: '76px',
    padding: '9px 14px',
    border: 0,
    borderRadius: '999px',
    background: '#fff',
    color: '#111',
    fontWeight: 700,
    cursor: 'pointer',
  },
  buttonDisabled: {
    opacity: 0.72,
    cursor: 'not-allowed',
  },
  speedButton: {
    minWidth: '58px',
    padding: '9px 10px',
    borderRadius: '999px',
    border: '1px solid rgba(255, 255, 255, 0.16)',
    background: 'rgba(255, 255, 255, 0.08)',
    color: '#fff',
    fontWeight: 800,
    cursor: 'pointer',
  },
  progressTrack: {
    flex: 1,
    height: '8px',
    overflow: 'hidden',
    borderRadius: '999px',
    background: 'rgba(255, 255, 255, 0.16)',
  },
  progressFill: {
    height: '100%',
    borderRadius: '999px',
    background: '#fff',
    transition: 'width 120ms linear',
  },
  status: {
    minWidth: '104px',
    fontSize: '13px',
    color: 'rgba(255, 255, 255, 0.72)',
    textAlign: 'right',
  },
}

export default PodcastPlayer
