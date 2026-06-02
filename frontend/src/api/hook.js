/**
 * Hook API client.
 *
 * Calls the backend to generate the cold-open text before the full-book
 * podcast pipeline continues.
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8001'

export async function generateBookHook({ title }) {
  let response
  try {
    response = await fetch(`${API_BASE}/api/generate-hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  } catch {
    throw new Error('Could not reach the server. Is the backend running?')
  }

  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.detail || `Request failed (${response.status})`)
  }

  return response.json()
}
