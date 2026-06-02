import { useState, useEffect, useRef, useCallback } from 'react'
import './BookAutocomplete.css'

/**
 * BookAutocomplete — the search box on the home page.
 *
 * As the user types we query the public Open Library search API
 * (https://openlibrary.org/search.json), rank the results so the closest
 * title matches float to the top, and show the best 6 as a dropdown.
 *
 * Performance touches, from top to bottom of this file:
 *   - normalize():        clean up text so matching is forgiving
 *   - editDistance/...:   fuzzy matching so small typos still match
 *   - scoreBook/rankBooks:rank + de-duplicate results
 *   - cache + getCachedPreview: reuse past results to feel instant
 *   - the component:      debounces typing, aborts stale requests, draws UI
 *
 * Note: this talks to Open Library directly — it does NOT use our own
 * backend. So search keeps working even with no server running.
 */

// ---------------------------------------------------------------------------
// Search helpers (pure functions, no React)
// ---------------------------------------------------------------------------

const cache = new Map()
const PLACEHOLDER = 'Search for any book...'
const SEARCH_DELAY = 80
const CACHE_VERSION = 'books-v5'

const normalize = (value = '') =>
  value
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const editDistance = (a, b) => {
  if (Math.abs(a.length - b.length) > 1) return 2

  let edits = 0
  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
    } else if (edits === 0 && a.length > b.length) {
      edits += 1
      i += 1
    } else if (edits === 0 && b.length > a.length) {
      edits += 1
      j += 1
    } else if (edits === 0) {
      edits += 1
      i += 1
      j += 1
    } else {
      return 2
    }
  }

  return edits + (a.length - i) + (b.length - j)
}

const wordMatches = (queryWord, titleWord) => {
  if (titleWord.startsWith(queryWord)) return true
  if (queryWord.length < 5) return false

  const comparableTitle = titleWord.slice(0, queryWord.length)
  return editDistance(queryWord, comparableTitle) <= 1
}

const searchTermsFor = (q) => {
  const words = q.split(' ')
  const terms = [q]

  if (words.length > 1) {
    terms.push(words.slice(0, -1).join(' '))
  }

  return [...new Set(terms.filter(term => term.length >= 2))]
}

const toBook = (book) => ({
  key: book.key,
  title: book.title,
  authors: book.author_name?.join(', ') || 'Unknown author',
  year: book.first_publish_year || null,
  cover_i: book.cover_i || null,
  cover_edition_key: book.cover_edition_key || null,
  edition_key: book.edition_key || null,
  isbn: book.isbn || null,
  lccn: book.lccn || null,
  editionCount: book.edition_count || 0,
  expectedPages: book.number_of_pages_median || null,
})

const scoreBook = (book, q) => {
  const title = normalize(book.title)
  if (!title || !q) return -1

  if (title === q) return 100000
  if (title.startsWith(q)) return 80000 - title.length
  if (title.includes(q)) return 50000 - title.indexOf(q) * 100

  const queryWords = q.split(' ')
  const titleWords = title.split(' ')

  if (queryWords.length > 1) {
    for (let i = 0; i <= titleWords.length - queryWords.length; i += 1) {
      const contiguousMatch = queryWords.every((queryWord, offset) =>
        wordMatches(queryWord, titleWords[i + offset])
      )

      if (contiguousMatch) {
        return 30000 - i * 500 - Math.abs(title.length - q.length) * 8
      }
    }

    return -1
  }

  const prefixMatches = queryWords.filter(queryWord =>
    titleWords.some(titleWord => wordMatches(queryWord, titleWord))
  ).length

  if (prefixMatches !== queryWords.length) return -1

  const firstMatchIndex = titleWords.findIndex(word => word.startsWith(queryWords[0]))
  const distancePenalty = firstMatchIndex < 0 ? 0 : firstMatchIndex * 250
  const lengthPenalty = Math.abs(title.length - q.length) * 8
  const popularityBoost = Math.min(book.edition_count || book.editionCount || 0, 40)

  return 5000 - distancePenalty - lengthPenalty + popularityBoost
}

const rankBooks = (books, q) => {
  const seen = new Set()

  return books
    .map(book => ({ ...toBook(book), score: scoreBook(book, q) }))
    .filter(book => book.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter(book => {
      const key = normalize(book.title)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 6)
}

const cacheKey = (q) => `${CACHE_VERSION}:${q}`

const getCachedPreview = (q) => {
  let bestMatch = []
  let bestLength = 0

  for (const [cachedQuery, books] of cache) {
    if (!cachedQuery.startsWith(CACHE_VERSION)) continue
    const query = cachedQuery.slice(CACHE_VERSION.length + 1)

    if (q.startsWith(query) && query.length > bestLength) {
      bestMatch = books
      bestLength = query.length
    }
  }

  return bestMatch
    .map(book => ({ ...book, score: scoreBook(book, q) }))
    .filter(book => book.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
}

export default function BookAutocomplete({ onSelect, className = '' }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [focused, setFocused] = useState(false)
  const [placeholder, setPlaceholder] = useState('')
  const [typing, setTyping] = useState(true)

  const abortRef = useRef(null)
  const debounceRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const latestQueryRef = useRef('')

  // Typewriter placeholder
  useEffect(() => {
    if (query || focused) return
    const next = typing
      ? PLACEHOLDER.slice(0, placeholder.length + 1)
      : placeholder.slice(0, -1)
    const done = typing ? placeholder === PLACEHOLDER : placeholder === ''
    const delay = done ? (typing ? 2000 : 500) : (typing ? 80 : 40)
    const t = setTimeout(() => {
      if (done) setTyping(!typing)
      else setPlaceholder(next)
    }, delay)
    return () => clearTimeout(t)
  }, [placeholder, typing, query, focused])

  const search = useCallback(async (raw) => {
    const q = normalize(raw)
    if (!q) return

    const key = cacheKey(q)
    if (cache.has(key)) {
      setResults(cache.get(key))
      setLoading(false)
      setOpen(true)
      return
    }

    abortRef.current?.abort()
    abortRef.current = new AbortController()
    latestQueryRef.current = q

    try {
      const responses = await Promise.all(searchTermsFor(q).map(async (term) => {
        const params = new URLSearchParams({
          title: term,
          fields: 'key,title,author_name,first_publish_year,cover_i,cover_edition_key,edition_key,isbn,lccn,edition_count,number_of_pages_median',
          limit: '25',
        })
        const res = await fetch(`https://openlibrary.org/search.json?${params}`, {
          signal: abortRef.current.signal,
        })
        if (!res.ok) throw new Error('Search failed')
        return res.json()
      }))
      if (latestQueryRef.current !== q) return

      const docs = responses.flatMap(data => data.docs || [])
      const ranked = rankBooks(docs, q)

      cache.set(key, ranked)
      setResults(ranked)
      setOpen(true)
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('Search error:', e)
        setResults([])
      }
    } finally {
      if (latestQueryRef.current !== q) return
      setLoading(false)
    }
  }, [])

  const handleChange = (e) => {
    const v = e.target.value
    setQuery(v)
    setActive(-1)
    clearTimeout(debounceRef.current)
    abortRef.current?.abort()

    const q = normalize(v)
    latestQueryRef.current = q

    if (!q) {
      setResults([])
      setOpen(false)
      setLoading(false)
      return
    }

    const key = cacheKey(q)
    if (cache.has(key)) {
      setResults(cache.get(key))
      setOpen(true)
      setLoading(false)
      return
    }

    const preview = getCachedPreview(q)
    setResults(preview.length ? preview : prev => prev.filter(book => scoreBook(book, q) > 0))
    setOpen(true)
    setLoading(true)
    debounceRef.current = setTimeout(() => search(v), SEARCH_DELAY)
  }

  const select = (book) => {
    setQuery(book.title)
    setResults([])
    setOpen(false)
    setActive(-1)
    onSelect?.(book)
    inputRef.current?.focus()
  }

  const handleKey = (e) => {
    if (!open || !results.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(p => (p + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(p => (p <= 0 ? results.length - 1 : p - 1))
    } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0) {
      e.preventDefault()
      select(results[active])
    } else if (e.key === 'Escape') {
      setOpen(false)
      setActive(-1)
    }
  }

  // Close on outside click
  useEffect(() => {
    const onClick = (e) => {
      if (
        !inputRef.current?.contains(e.target) &&
        !listRef.current?.contains(e.target)
      ) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  // Scroll active into view
  useEffect(() => {
    if (active >= 0) listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Cleanup
  useEffect(() => () => {
    clearTimeout(debounceRef.current)
    abortRef.current?.abort()
  }, [])

  return (
    <div className={`book-autocomplete ${className}`}>
      <div className="autocomplete-input-wrapper">
        <svg className="search-icon" width="20" height="20" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKey}
          onFocus={() => {
            setFocused(true)
            if (query.trim() && results.length) setOpen(true)
          }}
          onBlur={() => setFocused(false)}
          placeholder={focused || query ? PLACEHOLDER : placeholder}
          className="autocomplete-input"
          autoComplete="off"
          aria-label="Search for books"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-autocomplete="list"
        />
        {loading && <div className="loading-spinner"><div className="spinner" /></div>}
      </div>

      {open && (
        <ul ref={listRef} className="suggestions-list" role="listbox">
          {!results.length && (loading || query.trim()) ? (
            <li className="suggestion-empty">Keep typing for better matches</li>
          ) : !results.length ? (
            <li className="suggestion-empty">No books found</li>
          ) : results.map((book, i) => (
            <li
              key={book.key}
              role="option"
              aria-selected={i === active}
              className={`suggestion-item ${i === active ? 'active' : ''}`}
              onClick={() => select(book)}
              onMouseEnter={() => {
                setActive(i)
                if (book.cover_i) {
                  const img = new Image()
                  img.src = `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`
                }
              }}
            >
              <span className="suggestion-title">{book.title}</span>
              <span className="suggestion-meta">
                {book.authors}{book.year && ` • ${book.year}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
