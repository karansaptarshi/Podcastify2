import { useEffect, useMemo, useState } from 'react'

/**
 * Build a list of possible cover-image URLs for a book, best guess first.
 *
 * Open Library serves covers by several different IDs (internal id, edition
 * key, ISBN, LCCN). Any single one might 404, so we collect all of them and
 * try them in order, falling back to the next whenever one fails to load.
 * `?default=false` makes Open Library return a 404 instead of a blank image,
 * which is what lets us detect a failure and move on.
 */
function buildCoverUrls(book, size = 'M') {
  if (!book) return []

  const base = 'https://covers.openlibrary.org/b'
  const url = (path) => `${base}/${path}-${size}.jpg?default=false`
  const urls = []

  if (book.cover_i) urls.push(url(`id/${book.cover_i}`))
  if (book.cover_edition_key) urls.push(url(`olid/${book.cover_edition_key}`))
  book.edition_key?.slice(0, 3).forEach((olid) => urls.push(url(`olid/${olid}`)))
  book.isbn?.slice(0, 3).forEach((isbn) => urls.push(url(`isbn/${isbn}`)))
  if (book.lccn?.[0]) urls.push(url(`lccn/${book.lccn[0]}`))

  return [...new Set(urls)] // de-duplicate
}

/**
 * Manage loading the best available cover for a book.
 *
 * Returns:
 *   url          - the URL currently being shown (or null if none work)
 *   loaded       - true once the current URL has loaded successfully
 *   failed       - true once every candidate URL has failed
 *   tryNextOrFail- call from an <img onError> to advance to the next URL
 */
export function useBookCover(book, size = 'M') {
  const urls = useMemo(() => buildCoverUrls(book, size), [book, size])
  const [index, setIndex] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  const url = urls[index] || null

  // Start over whenever the book (and therefore the URL list) changes.
  useEffect(() => {
    setIndex(0)
    setLoaded(false)
    setFailed(false)
  }, [urls])

  // Preload the current URL. If it loads, great; if not, try the next one,
  // and if we've run out of candidates, mark the cover as failed.
  useEffect(() => {
    setLoaded(false)
    setFailed(false)

    if (!url) {
      setFailed(true)
      return
    }

    let cancelled = false
    const img = new Image()
    img.onload = () => { if (!cancelled) setLoaded(true) }
    img.onerror = () => {
      if (cancelled) return
      if (index < urls.length - 1) setIndex((i) => i + 1)
      else setFailed(true)
    }
    img.src = url

    return () => { cancelled = true }
  }, [url, index, urls.length])

  const tryNextOrFail = () => {
    setLoaded(false)
    if (index < urls.length - 1) setIndex((i) => i + 1)
    else setFailed(true)
  }

  return { url, loaded, failed, tryNextOrFail }
}
