import { useLocation, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import './BookDetails.css'

/**
 * BookDetails - Displays book cover and convert to podcast button
 * Uses Open Library Covers API for book cover images
 */
export default function BookDetails() {
  const location = useLocation()
  const navigate = useNavigate()
  const book = location.state?.book
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)

  // If no book data, redirect to home
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

  // Construct cover URL using Open Library Covers API
  // Using -M (medium) for faster loading, still good quality
  const getCoverUrl = (size = 'M') => {
    if (book.cover_i) {
      return `https://covers.openlibrary.org/b/id/${book.cover_i}-${size}.jpg`
    }
    if (book.isbn?.[0]) {
      return `https://covers.openlibrary.org/b/isbn/${book.isbn[0]}-${size}.jpg`
    }
    if (book.key) {
      const olid = book.key.split('/').pop()
      return `https://covers.openlibrary.org/b/olid/${olid}-${size}.jpg`
    }
    return null
  }

  const coverUrl = getCoverUrl('M')

  // Preload image on mount
  useEffect(() => {
    if (coverUrl) {
      const img = new Image()
      img.onload = () => setImageLoaded(true)
      img.onerror = () => setImageError(true)
      img.src = coverUrl
    }
  }, [coverUrl])

  const [isSearching, setIsSearching] = useState(false)
  const [searchStep, setSearchStep] = useState('')
  const [downloadError, setDownloadError] = useState(null)

  const handleSummary = async () => {
    setIsSearching(true)
    setDownloadError(null)
    
    try {
      const params = new URLSearchParams({
        title: book.title,
        author: book.authors || ''
      })
      
      // Step 1: Download full book PDF
      setSearchStep('Searching for book PDF...')
      
      const pdfResponse = await fetch(`http://localhost:8001/api/find-pdf?${params}`, {
        method: 'POST'
      })
      
      if (!pdfResponse.ok) {
        const error = await pdfResponse.json()
        throw new Error(error.detail || 'Failed to find book')
      }
      
      const pdfData = await pdfResponse.json()
      
      if (pdfData.cached) {
        setSearchStep('Book found in library!')
      } else {
        setSearchStep(`Downloaded book (${pdfData.pages} pages)`)
      }
      await new Promise(r => setTimeout(r, 500))
      
      // Step 2: Extract Chapter 1 using LLM
      setSearchStep('Analyzing book structure with AI...')
      await new Promise(r => setTimeout(r, 300))
      setSearchStep('Identifying Chapter 1 boundaries...')
      
      const chapterResponse = await fetch(`http://localhost:8001/api/extract-chapter?${params}`, {
        method: 'POST'
      })
      
      if (!chapterResponse.ok) {
        const error = await chapterResponse.json()
        throw new Error(error.detail || 'Failed to extract chapter')
      }
      
      const chapterData = await chapterResponse.json()
      
      if (chapterData.cached) {
        setSearchStep('Chapter 1 ready!')
      } else {
        setSearchStep(`Extracted Chapter 1: pages ${chapterData.start_page}-${chapterData.end_page}`)
      }
      await new Promise(r => setTimeout(r, 500))
      
      // Step 3: Generate podcast script
      setSearchStep('Writing podcast script with AI...')
      
      const scriptResponse = await fetch(`http://localhost:8001/api/generate-script?${params}`, {
        method: 'POST'
      })
      
      if (!scriptResponse.ok) {
        const error = await scriptResponse.json()
        throw new Error(error.detail || 'Failed to generate script')
      }
      
      const scriptData = await scriptResponse.json()
      setSearchStep('Podcast script ready!')
      await new Promise(r => setTimeout(r, 500))
      
      // Navigate to audio player page
      navigate('/player', { 
        state: { 
          book, 
          pdfInfo: pdfData,
          chapterInfo: chapterData,
          scriptInfo: scriptData
        } 
      })
      
    } catch (error) {
      console.error('Processing error:', error)
      setDownloadError(error.message)
      setIsSearching(false)
    }
  }

  const handleFullBook = () => {
    alert('🔒 Full book podcasts require a Pro subscription. Upgrade to unlock!')
  }

  // Full screen loading state when searching
  if (isSearching) {
    return (
      <div className="book-details-page">
        <div className="background-overlay"></div>
        <div className="background-blur"></div>
        
        <div className="searching-overlay">
          <div className="searching-content">
            {/* Animated book icon */}
            <div className="searching-icon">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
                <path d="M8 7h6"/>
                <path d="M8 11h8"/>
              </svg>
              <div className="searching-pulse"></div>
            </div>
            
            <h2 className="searching-title">{book.title}</h2>
            <p className="searching-step">{searchStep}</p>
            
            {/* Progress dots */}
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

  return (
    <div className="book-details-page">
      {/* Background elements */}
      <div className="background-overlay"></div>
      <div className="background-blur"></div>

      {/* Back button */}
      <button onClick={() => navigate('/')} className="back-button">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>
        Back
      </button>

      {/* Book content */}
      <div className="book-content">
        {/* Book cover */}
        <div className="cover-container">
          {/* Loading skeleton */}
          {!imageLoaded && !imageError && coverUrl && (
            <div className="cover-skeleton">
              <div className="skeleton-shimmer"></div>
            </div>
          )}
          
          {/* Actual image */}
          {coverUrl && !imageError && (
            <img 
              src={coverUrl} 
              alt={`${book.title} cover`}
              className={`book-cover ${imageLoaded ? 'loaded' : 'loading'}`}
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageError(true)}
            />
          )}
          
          {/* Placeholder when no cover */}
          {(!coverUrl || imageError) && (
            <div className="cover-placeholder">
              <span className="placeholder-title">{book.title}</span>
              <span className="placeholder-author">{book.authors}</span>
            </div>
          )}
        </div>

        {/* Book info */}
        <div className="book-info">
          <h1 className="book-title">{book.title}</h1>
          <p className="book-author">by {book.authors}</p>
          {book.year && <p className="book-year">First published: {book.year}</p>}
        </div>

        {/* Convert buttons */}
        <div className="convert-buttons">
          {/* Summary version - free */}
          <button 
            className="convert-button summary-button"
            onClick={handleSummary}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" x2="12" y1="19" y2="22"/>
            </svg>
            First Chapter
            <span className="button-badge free">~10 min</span>
          </button>

          {/* Full book version - locked/paid */}
          <button 
            className="convert-button full-button locked"
            onClick={handleFullBook}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" x2="12" y1="19" y2="22"/>
            </svg>
            Full Book Version
            <span className="button-badge pro">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              PRO
            </span>
          </button>
        </div>

        {/* Download error */}
        {downloadError && (
          <div className="download-error">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" x2="12" y1="8" y2="12"/>
              <line x1="12" x2="12.01" y1="16" y2="16"/>
            </svg>
            {downloadError}
          </div>
        )}
      </div>
    </div>
  )
}
