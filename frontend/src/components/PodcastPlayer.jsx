import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import useContinuousPlayer from '../hooks/useContinuousPlayer'

const PodcastPlayer = forwardRef(function PodcastPlayer({ hookUrl }, ref) {
  const player = useContinuousPlayer()
  const addedHookUrlRef = useRef(null)

  useImperativeHandle(ref, () => ({
    addClip: player.addClip,
    start: player.start,
    pause: player.pause,
  }), [player.addClip, player.pause, player.start])

  useEffect(() => {
    if (!hookUrl || addedHookUrlRef.current === hookUrl) return

    player.addClip(hookUrl)
    addedHookUrlRef.current = hookUrl
  }, [hookUrl, player])

  const togglePlayback = () => {
    if (player.isPlaying) {
      player.pause()
      return
    }

    player.start()
  }

  return (
    <div style={styles.shell}>
      <button type="button" onClick={togglePlayback} style={styles.button}>
        {player.isPlaying ? 'Pause' : 'Play'}
      </button>

      <div style={styles.progressTrack} aria-label="Current clip progress">
        <div style={{ ...styles.progressFill, width: `${player.progress * 100}%` }} />
      </div>

      <div style={styles.status}>
        {player.isWaiting ? 'loading next...' : player.isPlaying ? 'playing hook' : 'ready'}
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
    maxWidth: '560px',
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
