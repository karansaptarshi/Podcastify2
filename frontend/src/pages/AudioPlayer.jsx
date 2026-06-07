import { useLocation, useNavigate } from 'react-router-dom'
import { useState, useRef, useEffect } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import PodcastPlayer from '../components/PodcastPlayer'
import { getBookPreparation } from '../api/bookPreparation'
import { generateBookHook, renderHookLineAudio, streamBookChunkAudio } from '../api/hook'
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

function mergeUrls(currentUrls, nextUrls = []) {
  const seen = new Set(currentUrls)
  const merged = [...currentUrls]

  for (const url of nextUrls) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    merged.push(url)
  }

  return merged
}

function mergeClips(currentClips, nextClips = []) {
  const seen = new Set(currentClips.map((clip) => clip.audio_url))
  const merged = [...currentClips]

  for (const clip of nextClips) {
    if (!clip?.audio_url || seen.has(clip.audio_url)) continue
    seen.add(clip.audio_url)
    merged.push(clip)
  }

  return merged
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
  const {
    book,
    pdfInfo,
    scriptInfo,
    audioInfo,
    podcastScope,
    hookInfo: initialHookInfo,
    hookUrl: initialHookUrl,
    storedPdf,
    preparationKey,
    coverUrl: initialCoverUrl,
  } = location.state || {}

  const audioRef = useRef(null)
  const progressRef = useRef(null)
  const preparationJobRef = useRef(null)
  const initialHookAudioUrl = initialHookUrl || initialHookInfo?.audio_url || null
  const shouldPrepareFullBookAudio = podcastScope === 'full' && !audioInfo?.audio_url && !initialHookAudioUrl

  if (!preparationJobRef.current && preparationKey) {
    preparationJobRef.current = getBookPreparation(preparationKey)
  }

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [volume, setVolume] = useState(1)
  const [showScript, setShowScript] = useState(true)
  const [hookInfo, setHookInfo] = useState(initialHookInfo || null)
  const [hookUrl, setHookUrl] = useState(initialHookAudioUrl)
  const [introClipUrls, setIntroClipUrls] = useState(initialHookAudioUrl ? [initialHookAudioUrl] : [])
  const [bookClipUrls, setBookClipUrls] = useState(preparationJobRef.current?.bookClipUrls || [])
  const [bookAudioClips, setBookAudioClips] = useState(preparationJobRef.current?.bookAudioClips || [])
  const [introAudioDone, setIntroAudioDone] = useState(Boolean(initialHookAudioUrl || audioInfo?.audio_url))
  const [introPlaybackDone, setIntroPlaybackDone] = useState(false)
  const [isPreparingHookAudio, setIsPreparingHookAudio] = useState(shouldPrepareFullBookAudio)
  const [hookAudioError, setHookAudioError] = useState(null)
  const [livePdfInfo, setLivePdfInfo] = useState(pdfInfo || storedPdf || null)
  const [pdfStatusText, setPdfStatusText] = useState(
    pdfInfo || storedPdf ? 'Saved PDF + text to library.' : 'Downloading book in the background...'
  )
  const [pdfDownloadError, setPdfDownloadError] = useState(null)

  // Where the audio comes from (null in mock mode = nothing to play yet).
  const queuedClipUrls = audioInfo?.audio_url
    ? [audioInfo.audio_url]
    : introAudioDone
      ? [...introClipUrls, ...bookClipUrls]
      : introClipUrls
  const audioUrl = queuedClipUrls[0] || hookUrl || null
  const usesContinuousPlayer = podcastScope === 'full' || Boolean(hookUrl) || Boolean(queuedClipUrls.length)

  useEffect(() => {
    const job = preparationJobRef.current
    if (!job) return undefined

    return job.subscribe((nextJob) => {
      if (nextJob.hookInfo && !hookInfo?.hook) {
        setHookInfo(nextJob.hookInfo)
      }

      if (nextJob.pdfInfo) {
        setLivePdfInfo(nextJob.pdfInfo)
        setPdfStatusText('Saved PDF + text to library.')
        setPdfDownloadError(null)
      } else if (nextJob.pdfError) {
        setPdfDownloadError(nextJob.pdfError.message || 'Could not save the book.')
        setPdfStatusText('Book download needs attention.')
      } else if (nextJob.pdfStatusText) {
        setPdfStatusText(nextJob.pdfStatusText)
      }

      if (nextJob.bookClipUrls?.length) {
        setBookClipUrls((urls) => mergeUrls(urls, nextJob.bookClipUrls))
      }
      if (nextJob.bookAudioClips?.length) {
        setBookAudioClips((clips) => mergeClips(clips, nextJob.bookAudioClips))
      }
      if (nextJob.fullBookAudioError) {
        setHookAudioError(nextJob.fullBookAudioError.message || 'Could not prepare full-book audio.')
      }
      if (nextJob.fullBookAudioStarted && !nextJob.fullBookAudioDone) {
        setIsPreparingHookAudio(true)
      } else if (nextJob.fullBookAudioDone) {
        setIsPreparingHookAudio(false)
      }
    })
  }, [hookInfo?.hook, preparationKey])

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

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    audio.volume = volume
  }, [audioUrl, volume])

  useEffect(() => {
    if (!book || podcastScope !== 'full' || audioInfo?.audio_url) return

    const audioAbortController = new AbortController()
    const { signal } = audioAbortController
    let isActive = true

    setIsPreparingHookAudio(true)
    setHookAudioError(null)

    const renderIntroAudio = async () => {
      const preparationJob = preparationJobRef.current

      try {
        if (!introClipUrls.length && !hookUrl) {
          const nextHookInfo = hookInfo?.hook
            ? hookInfo
            : preparationJob?.hookInfo?.hook
              ? preparationJob.hookInfo
              : preparationJob
                ? await preparationJob.hookPromise
                : await generateBookHook({ title: book.title })

          if (!isActive || signal.aborted) return

          setHookInfo(nextHookInfo)

          const lines = parseScript(nextHookInfo.hook)
          if (!lines.length) {
            throw new Error('Intro script had no CHRIS/NAVAL lines.')
          }

          for (const [index, line] of lines.entries()) {
            if (!isActive || signal.aborted) return

            const audio = await renderHookLineAudio({
              title: nextHookInfo.book_name || book.title,
              speaker: line.speaker,
              text: line.text,
              lineIndex: index,
              signal,
            })

            if (!isActive || signal.aborted) return

            setIntroClipUrls((urls) => mergeUrls(urls, [audio.audio_url]))
          }
        }
      } catch (err) {
        if (signal.aborted || err?.name === 'AbortError') return
        console.warn('Could not prepare hook audio, continuing to book chunks:', err)
      } finally {
        if (isActive) {
          setIntroAudioDone(true)
        }
      }
    }

    const prepareBookAudio = async () => {
      const preparationJob = preparationJobRef.current

      try {
        if (preparationJob) {
          const nextPdfInfo =
            preparationJob.pdfInfo ||
            livePdfInfo ||
            storedPdf ||
            await preparationJob.pdfPromise

          if (!isActive || signal.aborted) return

          const runningBookAudio = preparationJob.startFullBookAudio?.(nextPdfInfo)
          if (!runningBookAudio && !preparationJob.fullBookAudioDone) {
            throw new Error('Book text chunks are not ready yet.')
          }

          if (preparationJob.bookClipUrls?.length) {
            setBookClipUrls((urls) => mergeUrls(urls, preparationJob.bookClipUrls))
          }
          if (preparationJob.bookAudioClips?.length) {
            setBookAudioClips((clips) => mergeClips(clips, preparationJob.bookAudioClips))
          }

          await runningBookAudio
          return
        }

        const nextPdfInfo =
          livePdfInfo ||
          storedPdf

        const textChunksKey = nextPdfInfo?.text_chunks_key
        const textChunkCount = Number(nextPdfInfo?.text_chunk_count || 0)
        if (!textChunksKey || !textChunkCount) {
          throw new Error('Book text chunks are not ready yet.')
        }

        for (let chunkIndex = 1; chunkIndex <= textChunkCount; chunkIndex += 1) {
          if (signal.aborted || !isActive) return

          await streamBookChunkAudio({
            title: book.title,
            textChunksKey,
            chunkIndex,
            lineBatchSize: 4,
            signal,
            onClip: (audio) => {
              if (signal.aborted || !isActive) return
              setBookClipUrls((urls) => mergeUrls(urls, [audio.audio_url]))
              setBookAudioClips((clips) => mergeClips(clips, [audio]))
            },
          })
        }
      } catch (err) {
        if (signal.aborted || err?.name === 'AbortError') {
          return
        }
        if (isActive) {
          setHookAudioError(err.message || 'Could not prepare full-book audio.')
        }
      }
    }

    Promise.allSettled([renderIntroAudio(), prepareBookAudio()])
      .finally(() => {
        if (isActive) {
          setIsPreparingHookAudio(false)
        }
      })

    return () => {
      isActive = false
      audioAbortController.abort()
      preparationJobRef.current?.cancelFullBookAudio?.()
    }
  }, [book, podcastScope, audioInfo?.audio_url])

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

  const coverUrl = initialCoverUrl || (book.cover_i
    ? `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`
    : null)
  const dialogues = parseScript(scriptInfo?.script)
  const bookDialogues = bookAudioClips.flatMap((clip, clipIndex) =>
    parseScript(clip.script).map((line, lineIndex) => ({
      ...line,
      key: `${clip.audio_url}-${clipIndex}-${lineIndex}`,
    }))
  )
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0
  const bookMetaText = livePdfInfo?.pages
    ? `${livePdfInfo.pages} pages`
    : pdfDownloadError
      ? 'Book download needs attention'
      : pdfStatusText || 'Downloading book...'

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

  const changeVolume = (event) => {
    setVolume(Math.max(0, Math.min(1, Number(event.target.value) || 0)))
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
              {bookMetaText} &bull; {podcastScope === 'full' ? 'Full book' : 'First chapter'}
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

        {hookInfo?.hook && !introPlaybackDone && (
          <div className="hook-container">
            <div className="hook-header">
              <h2>Intro</h2>
            </div>
            <p>{hookInfo.hook}</p>
          </div>
        )}

        {bookDialogues.length > 0 && (
          <div className="script-container">
            <div className="script-header">
              <h2>Book Conversation</h2>
              <button className="toggle-script-btn" onClick={() => setShowScript((v) => !v)}>
                {showScript ? 'Hide' : 'Show'}
              </button>
            </div>

            {showScript && (
              <div className="script-content">
                {bookDialogues.map((line) => (
                  <div key={line.key} className={`dialogue-line ${line.speaker.toLowerCase()}`}>
                    <span className="speaker-name">{line.speaker}</span>
                    <p className="speaker-text">{line.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Player (continuous queue for full-book generation, legacy player for single files). */}
        {usesContinuousPlayer ? (
          <>
            <PodcastPlayer
              hookUrl={hookUrl || audioInfo?.audio_url || null}
              clipUrls={queuedClipUrls}
              isPreparing={isPreparingHookAudio}
              error={hookAudioError}
              introClipCount={introAudioDone ? introClipUrls.length : 0}
              onIntroPlaybackDone={() => setIntroPlaybackDone(true)}
              autoStart
            />
          </>
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

              <label className="volume-control" title="Volume">
                {volume === 0 ? (
                  <VolumeX size={20} strokeWidth={2.2} aria-hidden="true" />
                ) : (
                  <Volume2 size={20} strokeWidth={2.2} aria-hidden="true" />
                )}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={changeVolume}
                  aria-label="Volume"
                  className="volume-slider"
                />
              </label>

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
