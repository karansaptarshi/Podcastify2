import { useLocation, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { findAndStorePdf } from '../api/pdf'
import { generateBookHook } from '../api/hook'
import { useBookCover } from '../hooks/useBookCover'
import './BookDetails.css'

/**
 * BookDetails — the second page.
 *
 * As soon as the user lands here (right after picking a book), we find the
 * book's PDF on the web and store it in Cloudflare R2 — showing a quick
 * loading screen while that happens. Once it's saved we show the book and two
 * buttons that turn it into a podcast:
 *   - "Summary"   -> just the first chapter   (scope: 'chapter')
 *   - "Full Book" -> the whole book           (scope: 'full')
 *
 * Full-book playback now navigates to the player shell directly. Summary
 * generation will be wired separately later.
 */
export default function BookDetails() {
  const location = useLocation()
  const navigate = useNavigate()
  const book = location.state?.book

  const [statusText, setStatusText] = useState('')
  const [error, setError] = useState(null)
  const [isGeneratingHook, setIsGeneratingHook] = useState(false)

  // The PDF find+store step that runs on arrival.
  //   phase: 'finding' | 'ready' | 'error'
  const [pdf, setPdf] = useState({ phase: 'finding', info: null, error: null })

  // Cover image (handles fallbacks + load/error state for us).
  const cover = useBookCover(book)

  // On arrival: locate the book's PDF and store it in R2.
  useEffect(() => {
    if (!book) return

    let cancelled = false
    setPdf({ phase: 'finding', info: null, error: null })
    setStatusText('fetching book...')

    findAndStorePdf({
      title: book.title,
      author: book.authors,
      expectedPages: book.expectedPages,
      onProgress: (text) => !cancelled && setStatusText(text),
    })
      .then((info) => {
        if (!cancelled) setPdf({ phase: 'ready', info, error: null })
      })
      .catch((err) => {
        if (!cancelled) {
          setPdf({ phase: 'error', info: null, error: err.message || 'Something went wrong' })
        }
      })

    return () => {
      cancelled = true
    }
  }, [book])

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

  const openFullBookPlayer = async () => {
    setError(null)
    setIsGeneratingHook(true)

    try {
      const hookInfo = await generateBookHook({ title: book.title })

      navigate('/player', {
        state: {
          book,
          storedPdf: pdf.info,
          pdfInfo: {
            pages: pdf.info?.pages,
            key: pdf.info?.key,
            text_key: pdf.info?.text_key,
          },
          podcastScope: 'full',
          hookInfo,
          hookUrl: null,
        },
      })
    } catch (err) {
      setError(err.message || 'Could not generate the opening hook.')
    } finally {
      setIsGeneratingHook(false)
    }
  }

  const showSummaryComingSoon = () => {
    setError('Summary generation is coming later.')
  }

  // While finding the PDF on arrival, show the loading overlay.
  if (pdf.phase === 'finding') {
    return (
      <div className="book-details-page">
        <div className="background-overlay"></div>
        <div className="background-blur"></div>

        <div className="searching-overlay">
          <div className="searching-content">
            <div className="searching-icon">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
                <path d="M8 7h6" />
                <path d="M8 11h8" />
              </svg>
              <div className="searching-pulse"></div>
            </div>

            <h2 className="searching-title">{book.title}</h2>
            <p className="searching-step">{statusText}</p>

            <div className="searching-dots">
              <span></span>
              <span></span>
              <span></span>
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
            <p className="pdf-status pdf-status-warn">
              Couldn't find the book.
            </p>
          )}
        </div>

        {/* Convert buttons */}
        <div className="convert-buttons">
          <button className="convert-button summary-button" onClick={showSummaryComingSoon}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" x2="12" y1="19" y2="22" />
            </svg>
            Summary
            <span className="button-badge free">5 minutes</span>
          </button>

          <button
            className={`convert-button full-button ${isGeneratingHook ? 'converting' : ''}`}
            onClick={openFullBookPlayer}
            disabled={isGeneratingHook}
          >
            {isGeneratingHook ? (
              <span className="button-spinner" aria-hidden="true"></span>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            )}
            {isGeneratingHook ? 'Writing hook...' : 'Full Book'}
            {!isGeneratingHook && <span className="button-badge duration">30 minutes</span>}
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
