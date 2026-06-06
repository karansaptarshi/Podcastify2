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

export async function renderHookAudio({ title, hook }) {
  let response
  try {
    response = await fetch(`${API_BASE}/api/render-hook-audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, hook }),
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

export async function renderHookLineAudio({ title, speaker, text, lineIndex = 0 }) {
  let response
  try {
    response = await fetch(`${API_BASE}/api/render-hook-line-audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        speaker,
        text,
        line_index: lineIndex,
      }),
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

export async function renderBookChunkAudio({ title, textChunksKey, chunkIndex }) {
  let response
  try {
    response = await fetch(`${API_BASE}/api/render-book-chunk-audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        text_chunks_key: textChunksKey,
        chunk_index: chunkIndex,
      }),
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

export async function streamBookChunkAudio({
  title,
  textChunksKey,
  chunkIndex,
  lineBatchSize = 4,
  onClip,
}) {
  let response
  try {
    response = await fetch(`${API_BASE}/api/stream-book-chunk-audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        text_chunks_key: textChunksKey,
        chunk_index: chunkIndex,
        line_batch_size: lineBatchSize,
      }),
    })
  } catch {
    throw new Error('Could not reach the server. Is the backend running?')
  }

  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.detail || `Request failed (${response.status})`)
  }

  if (!response.body) {
    throw new Error('The server did not return an audio stream.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const clips = []
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue

      const event = JSON.parse(line)
      if (event.error) {
        throw new Error(event.error)
      }

      clips.push(event)
      onClip?.(event)
    }

    if (done) break
  }

  if (buffer.trim()) {
    const event = JSON.parse(buffer)
    if (event.error) {
      throw new Error(event.error)
    }
    clips.push(event)
    onClip?.(event)
  }

  return clips
}
