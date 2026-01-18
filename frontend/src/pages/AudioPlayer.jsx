import { useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import './AudioPlayer.css'

/**
 * AudioPlayer - Page to play the generated podcast
 */
export default function AudioPlayer() {
  const location = useLocation()
  const navigate = useNavigate()
  const { book, pdfInfo, scriptInfo } = location.state || {}
  const [showScript, setShowScript] = useState(true)

  // If no data, redirect to home
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

  // Get cover URL
  const getCoverUrl = () => {
    if (book.cover_i) {
      return `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`
    }
    return null
  }

  const coverUrl = getCoverUrl()

  // Parse script into dialogue lines
  const parseScript = (script) => {
    if (!script) return []
    
    const lines = script.split('\n').filter(line => line.trim())
    const dialogues = []
    
    for (const line of lines) {
      const navalMatch = line.match(/^Naval:\s*(.+)/i)
      const chrisMatch = line.match(/^Chris:\s*(.+)/i)
      
      if (navalMatch) {
        dialogues.push({ speaker: 'Naval', text: navalMatch[1] })
      } else if (chrisMatch) {
        dialogues.push({ speaker: 'Chris', text: chrisMatch[1] })
      } else if (line.trim() && !line.startsWith('=')) {
        // Non-dialogue text (might be intro or description)
        if (dialogues.length > 0) {
          // Append to last speaker
          dialogues[dialogues.length - 1].text += ' ' + line.trim()
        }
      }
    }
    
    return dialogues
  }

  const dialogues = scriptInfo?.script ? parseScript(scriptInfo.script) : []

  return (
    <div className="audio-player-page">
      {/* Background */}
      <div className="audio-bg-gradient"></div>
      
      {/* Blurred cover background */}
      {coverUrl && (
        <div 
          className="audio-bg-cover" 
          style={{ backgroundImage: `url(${coverUrl})` }}
        ></div>
      )}

      {/* Back button */}
      <button onClick={() => navigate(-1)} className="back-button">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>
        Back
      </button>

      {/* Main content */}
      <div className="audio-content">
        {/* Header with cover and info */}
        <div className="audio-header">
          {/* Album art style cover */}
          <div className="audio-cover-small">
            {coverUrl ? (
              <img src={coverUrl} alt={book.title} />
            ) : (
              <div className="cover-placeholder-small">
                <span>{book.title.charAt(0)}</span>
              </div>
            )}
          </div>

          {/* Book info */}
          <div className="audio-info">
            <h1 className="audio-title">{book.title}</h1>
            <p className="audio-author">{book.authors}</p>
            <p className="audio-meta">
              {pdfInfo?.pages} pages • First chapter
              {scriptInfo && ` • ${scriptInfo.naval_lines + scriptInfo.chris_lines} dialogue lines`}
            </p>
          </div>
        </div>

        {/* Script display */}
        {scriptInfo?.script && (
          <div className="script-container">
            <div className="script-header">
              <h2>Podcast Script</h2>
              <button 
                className="toggle-script-btn"
                onClick={() => setShowScript(!showScript)}
              >
                {showScript ? 'Hide' : 'Show'}
              </button>
            </div>
            
            {showScript && (
              <div className="script-content">
                {dialogues.map((line, index) => (
                  <div 
                    key={index} 
                    className={`dialogue-line ${line.speaker.toLowerCase()}`}
                  >
                    <span className="speaker-name">{line.speaker}</span>
                    <p className="speaker-text">{line.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Audio player placeholder */}
        <div className="player-container">
          {/* Progress bar */}
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: '0%' }}></div>
          </div>
          
          <div className="time-display">
            <span>0:00</span>
            <span>10:00</span>
          </div>

          {/* Controls */}
          <div className="player-controls">
            <button className="control-btn secondary">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/>
              </svg>
            </button>
            
            <button className="control-btn primary play-btn">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </button>
            
            <button className="control-btn secondary">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/>
              </svg>
            </button>
          </div>

          {/* Additional controls */}
          <div className="extra-controls">
            <button className="extra-btn" title="Speed">
              <span>1x</span>
            </button>
            <button className="extra-btn" title="Download">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" x2="12" y1="15" y2="3"/>
              </svg>
            </button>
            <button className="extra-btn" title="Share">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="18" cy="5" r="3"/>
                <circle cx="6" cy="12" r="3"/>
                <circle cx="18" cy="19" r="3"/>
                <line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/>
                <line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Status message */}
        <div className="generating-status">
          <div className="status-spinner"></div>
          <span>Audio generation coming soon...</span>
        </div>
      </div>
    </div>
  )
}
