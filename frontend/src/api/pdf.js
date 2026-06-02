/**
 * PDF API client.
 *
 * Talks to the backend's `/api/find-pdf` route, which searches the web for a
 * text-extractable book PDF, downloads it, extracts readable text, and stores
 * both the PDF and .txt file in Cloudflare R2. The caller gets back the R2 keys
 * + URLs plus light metadata.
 *
 * Base URL can be overridden with `VITE_API_URL` (defaults to localhost:8001).
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8001'

/**
 * Find a book's PDF and store it in R2.
 *
 * @param {object}   args
 * @param {string}   args.title       - book title
 * @param {string}   [args.author]    - book author(s)
 * @param {number}   [args.expectedPages] - expected full-book page count
 * @param {function} [args.onProgress]- called with a status string for the UI
 * @returns {Promise<{
 *   key: string,
 *   url: string,
 *   text_key: string,
 *   text_url: string,
 *   pages: number,
 *   size_mb: number,
 *   text_chars: number,
 *   text_quality_score: number,
 *   ocr_used: boolean
 * }>}
 */
export async function findAndStorePdf({ title, author = '', expectedPages = null, onProgress }) {
  onProgress?.('Searching the web for the full book PDF...')

  let response
  try {
    response = await fetch(`${API_BASE}/api/find-pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, author, expected_pages: expectedPages }),
    })
  } catch {
    throw new Error('Could not reach the server. Is the backend running?')
  }

  if (!response.ok) {
    // FastAPI errors come back as { detail: "..." }.
    const data = await response.json().catch(() => null)
    throw new Error(data?.detail || `Request failed (${response.status})`)
  }

  onProgress?.('Saving to your library...')
  return response.json()
}
