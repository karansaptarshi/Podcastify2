import { useLocation, useNavigate } from 'react-router-dom'
import { useState, useEffect, useRef, useCallback } from 'react'
import { startBookPreparation } from '../api/bookPreparation'
import { useBookCover } from '../hooks/useBookCover'
import './BookDetails.css'

/**
 * BookDetails — the second page.
 *
 * After the user picks a book, this page starts full-book podcast conversion.
 * Full-book conversion starts the hook and PDF jobs together. The hook
 * gets the user to the player first; the PDF keeps saving in the background.
 *   - "Full Book" -> the whole book           (scope: 'full')
 */
export default function BookDetails() {
  const location = useLocation()
  const navigate = useNavigate()
  const book = location.state?.book

  const [statusText, setStatusText] = useState('')
  const [error, setError] = useState(null)
  const [manualPdfUrl, setManualPdfUrl] = useState('')
  const preparationRef = useRef({ bookKey: null, job: null })
  const unsubscribePreparationRef = useRef(null)
  const coverUrlRef = useRef(null)

  // The PDF find+store step that runs after the user starts conversion.
  //   phase: 'idle' | 'finding' | 'ready' | 'error'
  const [pdf, setPdf] = useState({ phase: 'idle', info: null, error: null })

  // Cover image (handles fallbacks + load/error state for us).
  const cover = useBookCover(book)

  useEffect(() => {
    coverUrlRef.current = cover.url
  }, [cover.url])

  const openFullBookPlayer = useCallback((selectedPdf = null, options = {}) => {
    if (!book) return

    const nextPdfInfo = selectedPdf
      ? {
          pages: selectedPdf?.pages,
          key: selectedPdf?.key,
          text_key: selectedPdf?.text_key,
          text_chunks_key: selectedPdf?.text_chunks_key,
          text_chunks_url: selectedPdf?.text_chunks_url,
          text_chunk_count: selectedPdf?.text_chunk_count,
          text_chunk_size: selectedPdf?.text_chunk_size,
        }
      : options.pdfInfo || null

    navigate('/player', {
      replace: Boolean(options.replace),
      state: {
        book,
        storedPdf: selectedPdf,
        pdfInfo: nextPdfInfo,
        podcastScope: 'full',
        hookInfo: options.hookInfo || null,
        hookUrl: null,
        preparationKey: options.preparationKey || preparationRef.current.job?.key || null,
        coverUrl: options.coverUrl || coverUrlRef.current || null,
      },
    })
  }, [book, navigate])

  const stopPreparationSubscription = useCallback(() => {
    unsubscribePreparationRef.current?.()
    unsubscribePreparationRef.current = null
  }, [])

  useEffect(() => stopPreparationSubscription, [stopPreparationSubscription])

  const startFullBookConversion = useCallback((sourceUrl = '') => {
    if (!book) return

    stopPreparationSubscription()

    const bookKey = `${book.key || book.title}-${book.authors || ''}-${sourceUrl || 'auto'}`
    const job = startBookPreparation({ book, sourceUrl })

    setError(null)
    setPdf({ phase: 'finding', info: null, error: null })
    setStatusText(sourceUrl ? 'Checking your PDF link...' : 'Writing the opening hook...')

    preparationRef.current = { bookKey, job }
    let finished = false

    const isCurrentJob = () => preparationRef.current.bookKey === bookKey

    const goToPlayer = (options = {}) => {
      if (finished || !isCurrentJob()) return

      finished = true
      stopPreparationSubscription()
      setStatusText('Opening player...')
      setManualPdfUrl('')
      openFullBookPlayer(options.pdfInfo || job.pdfInfo || null, {
        replace: true,
        hookInfo: options.hookInfo || job.hookInfo || null,
        preparationKey: job.key,
      })
    }

    const unsubscribe = job.subscribe((nextJob) => {
      if (finished || !isCurrentJob()) return

      if (nextJob.pdfInfo) {
        setPdf({ phase: 'ready', info: nextJob.pdfInfo, error: null })
      } else if (nextJob.pdfError) {
        setPdf({
          phase: 'error',
          info: null,
          error: nextJob.pdfError.message || 'Something went wrong',
        })
      }

      setStatusText(nextJob.hookInfo ? 'Opening player...' : nextJob.pdfStatusText)
    })
    unsubscribePreparationRef.current = unsubscribe

    job.hookPromise
      .then((hookInfo) => {
        goToPlayer({ hookInfo })
      })
      .catch((err) => {
        console.warn('Hook generation failed before PDF save:', err)

        job.pdfPromise
          .then((pdfInfo) => goToPlayer({ pdfInfo }))
          .catch((pdfErr) => {
            if (finished || !isCurrentJob()) return

            finished = true
            stopPreparationSubscription()
            setPdf({
              phase: 'error',
              info: null,
              error: pdfErr.message || 'Could not save the book.',
            })
            setStatusText(pdfErr.message || 'Could not save the book.')
          })
      })
  }, [book, openFullBookPlayer, stopPreparationSubscription])

  const saveManualPdf = async (event) => {
    event.preventDefault()

    const sourceUrl = manualPdfUrl.trim()
    if (!sourceUrl) {
      setError('Paste a direct PDF URL first.')
      return
    }

    startFullBookConversion(sourceUrl)
  }

  // No book was passed via navigation state -> offer a way home.
  if (!book) {
    return (
      <div className="book-details-page">
        <div className="error-container">
          <h2>No book selected</h2>
          <button onClick={() => navigate('/')} className="back-button">
            Go Back Home
          </button>
        </div>
      </div>
    )
  }

  // While finding the PDF on arrival, show the loading overlay.
  if (pdf.phase === 'finding') {
    return (
      <div className="book-details-page">
        <div className="background-overlay"></div>
        <div className="background-blur"></div>

        <div className="searching-overlay">
          <div className="studio-grid"></div>
          <div className="studio-beam studio-beam-left"></div>
          <div className="studio-beam studio-beam-right"></div>

          <div className="searching-content">
            <div className="studio-label">Podcastly Studio</div>

            <div className="conversion-stage" aria-hidden="true">
              <div className="sound-ring sound-ring-one"></div>
              <div className="sound-ring sound-ring-two"></div>
              <div className="sound-ring sound-ring-three"></div>

              <div className="cover-broadcast">
                {cover.url && !cover.failed ? (
                  <img src={cover.url} alt="" />
                ) : (
                  <div className="broadcast-placeholder">{book.title.charAt(0)}</div>
                )}
              </div>

              <div className="mic-node">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" x2="12" y1="19" y2="22" />
                </svg>
              </div>
            </div>

            <h2 className="searching-title">{book.title}</h2>
            <p className="searching-step">{statusText || `Converting ${book.title} into a podcast...`}</p>

            <div className="waveform-loader" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span><span></span>
              <span></span><span></span><span></span><span></span><span></span><span></span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Normal view: cover, info, and the two convert buttons.
  return (
    <div className="book-details-page">
      <div className="background-overlay"></div>
      <div className="background-blur"></div>

      <button onClick={() => navigate('/')} className="back-button">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Back
      </button>

      <div className="book-content">
        {/* Cover */}
        <div className="cover-container">
          {/* Loading shimmer while the image is still downloading */}
          {!cover.loaded && !cover.failed && cover.url && (
            <div className="cover-skeleton">
              <div className="skeleton-shimmer"></div>
            </div>
          )}

          {/* The cover image itself */}
          {cover.url && !cover.failed && (
            <img
              src={cover.url}
              alt={`${book.title} cover`}
              className={`book-cover ${cover.loaded ? 'loaded' : 'loading'}`}
              onLoad={() => { /* handled by the hook's preload */ }}
              onError={cover.tryNextOrFail}
            />
          )}

          {/* Text placeholder when no cover could be loaded */}
          {(!cover.url || cover.failed) && (
            <div className="cover-placeholder">
              <span className="placeholder-title">{book.title}</span>
              <span className="placeholder-author">{book.authors}</span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="book-info">
          <h1 className="book-title">{book.title}</h1>
          <p className="book-author">by {book.authors}</p>
          {book.year && <p className="book-year">First published: {book.year}</p>}

          {/* PDF library status */}
          {pdf.phase === 'ready' && (
            <p className="pdf-status pdf-status-ok">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Saved PDF + text to library &bull; {pdf.info?.pages} pages
            </p>
          )}
          {pdf.phase === 'error' && (
            <>
              <p className="pdf-status pdf-status-warn">
                Couldn't find the book automatically.
              </p>
              <p className="pdf-error-detail">{pdf.error}</p>
            </>
          )}
        </div>

        {pdf.phase === 'error' && (
          <form className="manual-pdf-card" onSubmit={saveManualPdf}>
            <label htmlFor="manual-pdf-url">Have a direct PDF link?</label>
            <div className="manual-pdf-row">
              <input
                id="manual-pdf-url"
                type="url"
                value={manualPdfUrl}
                onChange={(event) => setManualPdfUrl(event.target.value)}
                placeholder="https://example.com/book.pdf"
              />
              <button type="submit">Use Link</button>
            </div>
          </form>
        )}

        {/* Convert buttons */}
        <div className="convert-buttons">
          <button
            className="convert-button full-button"
            onClick={() => startFullBookConversion()}
            disabled={pdf.phase === 'finding'}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" x2="12" y1="19" y2="22" />
            </svg>
            Full Book
            <span className="button-badge duration">30 minutes</span>
          </button>
        </div>

        {/* Error message (if generation failed) */}
        {error && (
          <div className="download-error">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" x2="12" y1="8" y2="12" />
              <line x1="12" x2="12.01" y1="16" y2="16" />
            </svg>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
