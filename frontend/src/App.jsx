import { useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import BookAutocomplete from './components/BookAutocomplete'
import './App.css'

/**
 * App — the home page.
 *
 * Just a title, a tagline, and a search box. When the user picks a book from
 * the search box we navigate to the details page and hand the book along in
 * the router's `state` so the next page can read it.
 */
function App() {
  const navigate = useNavigate()

  // Drives the fade-in: flips to true a moment after mount.
  const [showContent, setShowContent] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100)
    return () => clearTimeout(timer)
  }, [])

  // BookAutocomplete calls this with the chosen book.
  const handleBookSelect = (book) => {
    navigate('/book', { state: { book } })
  }

  // Each letter is its own <span> so CSS can animate them individually.
  const titleLetters = 'Podcastly'.split('')

  return (
    <div className="homepage">
      {/* Background overlay */}
      <div className="background-overlay"></div>
      
      {/* Background image */}
      <div className="background-image"></div>
      
      {/* Content */}
      <div className={`content ${showContent ? 'visible' : ''}`}>
        <h1 className="title glitch-wrapper">
          <span className="title-text" data-text="Podcastly">
            {titleLetters.map((letter, index) => (
              <span 
                key={index} 
                className={`title-letter ${index < 7 ? 'podcast-letter' : 'ify-letter'}`}
                style={{ '--letter-index': index }}
              >
                {letter}
              </span>
            ))}
          </span>
          {/* Glitch layers */}
          <span className="glitch-layer glitch-1" aria-hidden="true">Podcastly</span>
          <span className="glitch-layer glitch-2" aria-hidden="true">Podcastly</span>
        </h1>
        
        <p className="tagline">Listen to any book as a Podcast</p>
        
        <div className="search-container">
          <BookAutocomplete onSelect={handleBookSelect} />
        </div>
      </div>
    </div>
  )
}

export default App
