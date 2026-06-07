import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import useContinuousPlayer from '../hooks/useContinuousPlayer'

const PodcastPlayer = forwardRef(function PodcastPlayer({
  hookUrl,
  clipUrls = [],
  isPreparing = false,
  error = null,
  autoStart = false,
  introClipCount = 0,
  onIntroPlaybackDone,
}, ref) {
  const player = useContinuousPlayer()
  const addedClipUrlsRef = useRef(new Set())
  const autoStartedHookUrlRef = useRef(null)
  const completedIntroCountRef = useRef(0)
  const VolumeIcon = player.volume === 0 ? VolumeX : Volume2

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

  useEffect(() => {
    if (!introClipCount || player.finishedClipCount < introClipCount) return
    if (completedIntroCountRef.current === introClipCount) return

    completedIntroCountRef.current = introClipCount
    onIntroPlaybackDone?.()
  }, [introClipCount, onIntroPlaybackDone, player.finishedClipCount])

  const togglePlayback = () => {
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
        style={styles.button}
      >
        {player.isPlaying ? 'Pause' : 'Play'}
      </button>

      <label style={styles.volumeControl} title="Volume">
        <VolumeIcon size={18} strokeWidth={2.2} aria-hidden="true" />
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={player.volume}
          onChange={(event) => player.setVolume(event.target.value)}
          aria-label="Volume"
          style={styles.volumeSlider}
        />
      </label>

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
        {error || player.error || (!hookUrl && !clipUrls.length && isPreparing ? 'preparing audio...' : player.isPlaying ? 'playing' : 'ready')}
      </div>

      <audio
        ref={player.audioRef}
        preload="auto"
        playsInline
        style={styles.nativeAudio}
      />
    </div>
  )
})

const styles = {
  shell: {
    display: 'flex',
    flexWrap: 'wrap',
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
  volumeControl: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '124px',
    minWidth: '112px',
    color: 'rgba(255, 255, 255, 0.78)',
  },
  volumeSlider: {
    width: '92px',
    accentColor: '#fff',
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
  nativeAudio: {
    width: '1px',
    height: '1px',
    opacity: 0.01,
    position: 'absolute',
    pointerEvents: 'none',
  },
}

export default PodcastPlayer
