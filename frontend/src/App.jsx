import { useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import BookAutocomplete from './components/BookAutocomplete'
import './App.css'

function App() {
  const navigate = useNavigate()
  const [showContent, setShowContent] = useState(false)

  // Show content after a brief delay
  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100)
    return () => clearTimeout(timer)
  }, [])

  // Handle book selection - navigate to book details page
  const handleBookSelect = (book) => {
    navigate('/book', { state: { book } })
  }

  // Split title for letter animation
  const titleLetters = "Podcastify".split('')

  return (
    <div className="homepage">
      {/* Background overlay */}
      <div className="background-overlay"></div>
      
      {/* Background image */}
      <div className="background-image"></div>
      
      {/* Content */}
      <div className={`content ${showContent ? 'visible' : ''}`}>
        <h1 className="title glitch-wrapper">
          <span className="title-text" data-text="Podcastify">
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
          <span className="glitch-layer glitch-1" aria-hidden="true">Podcastify</span>
          <span className="glitch-layer glitch-2" aria-hidden="true">Podcastify</span>
        </h1>
        
        <p className="tagline">Convert any book into a podcast</p>
        
        <div className="search-container">
          <BookAutocomplete onSelect={handleBookSelect} />
        </div>
      </div>
    </div>
  )
}

export default App
