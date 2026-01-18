import { useState, useEffect, useRef, useCallback } from 'react'
import './BookAutocomplete.css'

/**
 * BookAutocomplete - A reusable autocomplete input for searching books
 * Uses Open Library Search API with debouncing, caching, and keyboard navigation
 */

// In-memory cache to avoid repeat API requests
const searchCache = new Map()

/**
 * Calculate how well a book title matches the search query
 * Returns a score between 0 and 100
 */
const calculateTitleMatch = (title, query) => {
  if (!title || !query) return 0
  
  const normalizedTitle = title.toLowerCase().trim()
  const normalizedQuery = query.toLowerCase().trim()
  
  // Exact match - highest score
  if (normalizedTitle === normalizedQuery) return 100
  
  // Title starts with exact query
  if (normalizedTitle.startsWith(normalizedQuery)) return 95
  
  // Query starts with title (user typed more than title)
  if (normalizedQuery.startsWith(normalizedTitle)) return 90
  
  // Title contains query as a complete phrase
  if (normalizedTitle.includes(normalizedQuery)) return 85
  
  // Word-by-word matching
  const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 1)
  const titleWords = normalizedTitle.split(/\s+/)
  
  if (queryWords.length === 0) return 0
  
  let matchedWords = 0
  let partialMatches = 0
  
  for (const qWord of queryWords) {
    let foundExact = false
    let foundPartial = false
    
    for (const tWord of titleWords) {
      if (tWord === qWord) {
        foundExact = true
        break
      } else if (tWord.startsWith(qWord) || qWord.startsWith(tWord)) {
        foundPartial = true
      }
    }
    
    if (foundExact) matchedWords++
    else if (foundPartial) partialMatches++
  }
  
  // Score based on word matches
  const exactRatio = matchedWords / queryWords.length
  const partialRatio = partialMatches / queryWords.length
  
  return Math.round(exactRatio * 70 + partialRatio * 20)
}

// Typewriter text to cycle through
const TYPEWRITER_TEXT = "Search for any book..."
const TYPING_SPEED = 80      // ms per character when typing
const DELETING_SPEED = 40    // ms per character when deleting
const PAUSE_AFTER_TYPE = 2000 // pause after fully typed
const PAUSE_AFTER_DELETE = 500 // pause after fully deleted

export default function BookAutocomplete({ 
  onSelect,
  className = ""
}) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [isFocused, setIsFocused] = useState(false)
  
  // Typewriter animation state
  const [displayPlaceholder, setDisplayPlaceholder] = useState('')
  const [isTyping, setIsTyping] = useState(true)
  
  // Refs for managing async operations and DOM elements
  const abortControllerRef = useRef(null)
  const debounceTimerRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  /**
   * Typewriter effect - types and untypes the placeholder text
   */
  useEffect(() => {
    // Don't animate if user has typed something or input is focused
    if (query.length > 0 || isFocused) return

    let timeout

    if (isTyping) {
      // Typing phase
      if (displayPlaceholder.length < TYPEWRITER_TEXT.length) {
        timeout = setTimeout(() => {
          setDisplayPlaceholder(TYPEWRITER_TEXT.slice(0, displayPlaceholder.length + 1))
        }, TYPING_SPEED)
      } else {
        // Finished typing, pause then start deleting
        timeout = setTimeout(() => {
          setIsTyping(false)
        }, PAUSE_AFTER_TYPE)
      }
    } else {
      // Deleting phase
      if (displayPlaceholder.length > 0) {
        timeout = setTimeout(() => {
          setDisplayPlaceholder(displayPlaceholder.slice(0, -1))
        }, DELETING_SPEED)
      } else {
        // Finished deleting, pause then start typing again
        timeout = setTimeout(() => {
          setIsTyping(true)
        }, PAUSE_AFTER_DELETE)
      }
    }

    return () => clearTimeout(timeout)
  }, [displayPlaceholder, isTyping, query, isFocused])

  /**
   * Fetch books from Open Library API
   * Uses general search (q=) for better autocomplete results
   */
  const fetchBooks = useCallback(async (searchQuery) => {
    const cleanQuery = searchQuery.trim()
    
    // Check cache first
    const cacheKey = cleanQuery.toLowerCase()
    if (searchCache.has(cacheKey)) {
      setSuggestions(searchCache.get(cacheKey))
      setIsLoading(false)
      setIsOpen(true)
      return
    }

    // Cancel any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    abortControllerRef.current = new AbortController()

    try {
      // Use general 'q' search - works much better for autocomplete
      // Fetch more results to filter and rank them client-side
      const params = new URLSearchParams({
        q: cleanQuery,
        fields: 'title,author_name,first_publish_year,key,cover_i,isbn,edition_count,ratings_average,number_of_pages_median',
        limit: '25'  // Get more results to filter
      })

      const response = await fetch(
        `https://openlibrary.org/search.json?${params}`,
        { signal: abortControllerRef.current.signal }
      )

      if (!response.ok) throw new Error('Search failed')

      const data = await response.json()
      
      // Transform and score results
      let results = data.docs
        .map(book => {
          const titleScore = calculateTitleMatch(book.title, cleanQuery)
          const popularityScore = Math.min((book.edition_count || 0) / 100, 1) * 20 // Max 20 points
          const ratingScore = (book.ratings_average || 0) * 2 // Max 10 points
          const hasYear = book.first_publish_year ? 5 : 0
          const hasCover = book.cover_i ? 5 : 0
          
          return {
            key: book.key,
            title: book.title,
            authors: book.author_name?.join(', ') || 'Unknown author',
            year: book.first_publish_year || null,
            cover_i: book.cover_i || null,
            isbn: book.isbn || null,
            editionCount: book.edition_count || 0,
            // Combined relevance score
            score: titleScore + popularityScore + ratingScore + hasYear + hasCover,
            titleScore
          }
        })
        // Filter: must have reasonable title match OR be very popular
        .filter(book => book.titleScore >= 20 || book.editionCount > 50)
        // Sort by combined score
        .sort((a, b) => b.score - a.score)
        // Remove duplicates (same title, different editions)
        .filter((book, index, arr) => {
          const normalizedTitle = book.title.toLowerCase().replace(/[^\w\s]/g, '')
          return index === arr.findIndex(b => 
            b.title.toLowerCase().replace(/[^\w\s]/g, '') === normalizedTitle
          )
        })
        // Take top 6
        .slice(0, 6)

      // Cache the results
      searchCache.set(cacheKey, results)
      
      setSuggestions(results)
      setIsOpen(true)
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Search error:', error)
        setSuggestions([])
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  /**
   * Handle input changes with debouncing
   * Triggers search after 2+ characters for faster results
   */
  const handleInputChange = (e) => {
    const value = e.target.value
    setQuery(value)
    setActiveIndex(-1)

    // Clear existing debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    // Reset state for very short queries
    if (value.trim().length < 2) {
      setSuggestions([])
      setIsOpen(false)
      setIsLoading(false)
      return
    }

    // Show loading immediately
    setIsLoading(true)
    
    // Debounce search - shorter delay for better responsiveness
    debounceTimerRef.current = setTimeout(() => {
      fetchBooks(value)
    }, 200)
  }

  /**
   * Select a book suggestion
   */
  const selectSuggestion = (book) => {
    setQuery(book.title)
    setSuggestions([])
    setIsOpen(false)
    setActiveIndex(-1)
    onSelect?.(book)
    inputRef.current?.focus()
  }

  /**
   * Keyboard navigation handler
   */
  const handleKeyDown = (e) => {
    if (!isOpen || suggestions.length === 0) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex(prev => 
          prev < suggestions.length - 1 ? prev + 1 : 0
        )
        break
        
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex(prev => 
          prev > 0 ? prev - 1 : suggestions.length - 1
        )
        break
        
      case 'Enter':
      case 'Tab':
        if (activeIndex >= 0 && activeIndex < suggestions.length) {
          e.preventDefault()
          selectSuggestion(suggestions[activeIndex])
        }
        break
        
      case 'Escape':
        setIsOpen(false)
        setActiveIndex(-1)
        break
    }
  }

  /**
   * Close dropdown when clicking outside
   */
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        inputRef.current && 
        !inputRef.current.contains(e.target) &&
        listRef.current &&
        !listRef.current.contains(e.target)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  /**
   * Scroll active suggestion into view
   */
  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const activeElement = listRef.current.children[activeIndex]
      activeElement?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex])

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      if (abortControllerRef.current) abortControllerRef.current.abort()
    }
  }, [])

  return (
    <div className={`book-autocomplete ${className}`}>
      <div className="autocomplete-input-wrapper">
        <svg 
          className="search-icon" 
          width="20" 
          height="20" 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            setIsFocused(true)
            if (query.trim().length >= 2 && suggestions.length > 0) setIsOpen(true)
          }}
          onBlur={() => setIsFocused(false)}
          placeholder={isFocused || query.length > 0 ? "Search for any book..." : displayPlaceholder}
          className="autocomplete-input"
          autoComplete="off"
          aria-label="Search for books"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-autocomplete="list"
        />

        {/* Loading spinner */}
        {isLoading && (
          <div className="loading-spinner" aria-label="Loading">
            <div className="spinner"></div>
          </div>
        )}
      </div>

      {/* Suggestions dropdown */}
      {isOpen && (
        <ul 
          ref={listRef}
          className="suggestions-list"
          role="listbox"
        >
          {suggestions.length === 0 && !isLoading ? (
            <li className="suggestion-empty">No books found</li>
          ) : (
            suggestions.map((book, index) => (
              <li
                key={book.key}
                role="option"
                aria-selected={index === activeIndex}
                className={`suggestion-item ${index === activeIndex ? 'active' : ''}`}
                onClick={() => selectSuggestion(book)}
                onMouseEnter={() => {
                  setActiveIndex(index)
                  // Preload cover image on hover for faster page load
                  if (book.cover_i) {
                    const img = new Image()
                    img.src = `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`
                  }
                }}
              >
                <span className="suggestion-title">{book.title}</span>
                <span className="suggestion-meta">
                  {book.authors}
                  {book.year && ` • ${book.year}`}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}

