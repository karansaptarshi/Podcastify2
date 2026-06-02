import { useLocation, useNavigate } from 'react-router-dom'
import { useState, useRef, useEffect, useCallback } from 'react'
import PodcastPlayer from '../components/PodcastPlayer'
import './AudioPlayer.css'

// Turn a number of seconds into "m:ss" (e.g. 75 -> "1:15").
function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Split a raw "Naval: ... / Chris: ..." script into [{ speaker, text }].
// Lines without a speaker tag are appended to the previous speaker's text.
function parseScript(script) {
  if (!script) return []
  const dialogues = []

  for (const line of script.split('\n')) {
    const match = line.match(/^(Naval|Chris):\s*(.+)/i)
    if (match) {
      const speaker = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()
      dialogues.push({ speaker, text: match[2] })
    } else if (line.trim() && !line.startsWith('=') && dialogues.length) {
      dialogues[dialogues.length - 1].text += ' ' + line.trim()
    }
  }
  return dialogues
}

/**
 * AudioPlayer — the third page.
 *
 * Receives the book + generated podcast data from BookDetails (via router
 * state) and plays it. The audio URL comes straight from `audioInfo.audio_url`
 * so this page doesn't care where the audio lives (real backend, CDN, etc.).
 */
export default function AudioPlayer() {
  const location = useLocation()
  const navigate = useNavigate()
  const { book, pdfInfo, scriptInfo, audioInfo, podcastScope, hookInfo, hookUrl } = location.state || {}

  const audioRef = useRef(null)
  const progressRef = useRef(null)

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [showScript, setShowScript] = useState(true)

  // Where the audio comes from (null in mock mode = nothing to play yet).
  const audioUrl = audioInfo?.audio_url || hookUrl || null
  const usesContinuousPlayer = podcastScope === 'full' || Boolean(hookUrl)

  // Wire up the <audio> element's events to our React state.
  // (Declared before the early return so hooks always run in the same order.)
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onTime = () => setCurrentTime(audio.currentTime)
    const onMeta = () => setDuration(audio.duration)
    const onEnded = () => { setIsPlaying(false); setCurrentTime(0) }

    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    audio.addEventListener('ended', onEnded)

    return () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('durationchange', onMeta)
      audio.removeEventListener('ended', onEnded)
    }
  }, [audioUrl])

  // Reached this page without a book -> send the user home.
  if (!book) {
    return (
      <div className="audio-player-page">
        <div className="error-container">
          <h2>No book selected</h2>
          <button onClick={() => navigate('/')} className="back-button">
            Go Back Home
          </button>
        </div>
      </div>
    )
  }

  const coverUrl = book.cover_i
    ? `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`
    : null
  const dialogues = parseScript(scriptInfo?.script)
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  // --- Player controls ---
  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio) return
    audio.paused ? audio.play() : audio.pause()
  }

  const skip = (seconds) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + seconds))
  }

  const cycleSpeed = () => {
    const speeds = [1, 1.25, 1.5, 2]
    const next = speeds[(speeds.indexOf(playbackRate) + 1) % speeds.length]
    setPlaybackRate(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  const seekToClick = (e) => {
    const bar = progressRef.current
    const audio = audioRef.current
    if (!bar || !audio || !audio.duration) return
    const rect = bar.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audio.currentTime = pct * audio.duration
  }

  const download = () => {
    if (!audioUrl) return
    const a = document.createElement('a')
    a.href = audioUrl
    a.download = audioInfo?.audio_filename || 'podcast.mp3'
    a.click()
  }

  return (
    <div className="audio-player-page">
      <div className="audio-bg-gradient"></div>
      {coverUrl && (
        <div className="audio-bg-cover" style={{ backgroundImage: `url(${coverUrl})` }}></div>
      )}

      <button onClick={() => navigate(-1)} className="back-button">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Back
      </button>

      <div className="audio-content">
        {/* Header: cover + title + meta */}
        <div className="audio-header">
          <div className="audio-cover-small">
            {coverUrl ? (
              <img src={coverUrl} alt={book.title} />
            ) : (
              <div className="cover-placeholder-small">
                <span>{book.title.charAt(0)}</span>
              </div>
            )}
          </div>
          <div className="audio-info">
            <h1 className="audio-title">{book.title}</h1>
            <p className="audio-author">{book.authors}</p>
            <p className="audio-meta">
              {pdfInfo?.pages} pages &bull; {podcastScope === 'full' ? 'Full book' : 'First chapter'}
              {scriptInfo && ` \u2022 ${scriptInfo.naval_lines + scriptInfo.chris_lines} dialogue lines`}
            </p>
          </div>
        </div>

        {/* Transcript */}
        {scriptInfo?.script && (
          <div className="script-container">
            <div className="script-header">
              <h2>Podcast Script</h2>
              <button className="toggle-script-btn" onClick={() => setShowScript((v) => !v)}>
                {showScript ? 'Hide' : 'Show'}
              </button>
            </div>

            {showScript && (
              <div className="script-content">
                {dialogues.map((line, index) => (
                  <div key={index} className={`dialogue-line ${line.speaker.toLowerCase()}`}>
                    <span className="speaker-name">{line.speaker}</span>
                    <p className="speaker-text">{line.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {hookInfo?.hook && (
          <div className="hook-container">
            <div className="hook-header">
              <h2>Opening Hook</h2>
              {hookInfo.model && <span>{hookInfo.model}</span>}
            </div>
            <p>{hookInfo.hook}</p>
          </div>
        )}

        {/* Player (continuous queue for full-book generation, legacy player for single files). */}
        {usesContinuousPlayer ? (
          <PodcastPlayer hookUrl={hookUrl || audioInfo?.audio_url || null} />
        ) : audioUrl ? (
          <div className="player-container">
            <audio ref={audioRef} src={audioUrl} preload="metadata" />

            <div className="progress-bar" ref={progressRef} onClick={seekToClick}>
              <div className="progress-fill" style={{ width: `${progress}%` }}></div>
              <div className="progress-thumb" style={{ left: `${progress}%` }}></div>
            </div>

            <div className="time-display">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>

            <div className="player-controls">
              <button className="control-btn secondary" onClick={() => skip(-15)} title="Back 15s">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 17l-5-5 5-5" />
                  <path d="M18 17l-5-5 5-5" />
                </svg>
              </button>

              <button className={`control-btn primary play-btn ${isPlaying ? 'playing' : ''}`} onClick={togglePlay}>
                {isPlaying ? (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              <button className="control-btn secondary" onClick={() => skip(15)} title="Forward 15s">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M13 17l5-5-5-5" />
                  <path d="M6 17l5-5-5-5" />
                </svg>
              </button>
            </div>

            <div className="extra-controls">
              <button className="extra-btn" title="Playback speed" onClick={cycleSpeed}>
                <span>{playbackRate}x</span>
              </button>
              <button className="extra-btn" title="Download" onClick={download}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" x2="12" y1="15" y2="3" />
                </svg>
              </button>
            </div>
          </div>
        ) : (
          <div className="generating-status">
            <span>No audio yet — hook up the backend to play this podcast.</span>
          </div>
        )}
      </div>
    </div>
  )
}
