import { generateBookHook, streamBookChunkAudio } from './hook'
import { findAndStorePdf } from './pdf'

const jobs = new Map()
const BOOK_AUDIO_LOOKAHEAD_CHUNKS = 2

export function bookPreparationKey(book, sourceUrl = '') {
  if (!book) return ''

  const bookId = book.key || book.title || 'book'
  return [bookId, book.authors || '', sourceUrl || 'auto'].join('::')
}

function notify(job) {
  job.listeners.forEach((listener) => listener(job))
}

function releaseReadyBookClips(job, chunkStates, nextReleaseRef) {
  let released = false

  while (true) {
    const chunkState = chunkStates.get(nextReleaseRef.current)
    if (!chunkState) break

    while (chunkState.releasedCount < chunkState.clips.length) {
      const clip = chunkState.clips[chunkState.releasedCount]
      job.bookClipUrls.push(clip.audio_url)
      job.bookAudioClips.push(clip)
      chunkState.releasedCount += 1
      released = true
    }

    if (!chunkState.done) break

    chunkStates.delete(nextReleaseRef.current)
    nextReleaseRef.current += 1
  }

  if (released) {
    notify(job)
  }
}

function startFullBookAudio(job, pdfInfo) {
  if (job.fullBookAudioStarted) return job.fullBookAudioPromise

  const textChunksKey = pdfInfo?.text_chunks_key
  const textChunkCount = Number(pdfInfo?.text_chunk_count || 0)
  if (!textChunksKey || !textChunkCount) {
    return null
  }

  job.fullBookAudioStarted = true
  job.fullBookAudioStatusText = 'Preparing book audio...'
  notify(job)

  job.fullBookAudioPromise = (async () => {
    const maxParallelChunks = BOOK_AUDIO_LOOKAHEAD_CHUNKS + 1
    const chunkStates = new Map()
    const activeChunks = new Set()
    const nextReleaseRef = { current: 1 }
    let nextChunkToStart = 1

    const startChunk = (chunkIndex) => {
      const chunkState = {
        clips: [],
        done: false,
        releasedCount: 0,
      }
      chunkStates.set(chunkIndex, chunkState)

      job.fullBookAudioStatusText = `Preparing book audio ${chunkIndex}/${textChunkCount}...`
      notify(job)

      const chunkPromise = streamBookChunkAudio({
        title: job.book.title,
        textChunksKey,
        chunkIndex,
        lineBatchSize: 4,
        onClip: (clip) => {
          chunkState.clips.push(clip)
          releaseReadyBookClips(job, chunkStates, nextReleaseRef)
        },
      }).then(() => {
        chunkState.done = true
        releaseReadyBookClips(job, chunkStates, nextReleaseRef)
      })

      let trackedPromise
      trackedPromise = chunkPromise.finally(() => {
        activeChunks.delete(trackedPromise)
      })
      activeChunks.add(trackedPromise)
    }

    const startAvailableChunks = () => {
      while (nextChunkToStart <= textChunkCount && activeChunks.size < maxParallelChunks) {
        startChunk(nextChunkToStart)
        nextChunkToStart += 1
      }
    }

    try {
      startAvailableChunks()

      while (activeChunks.size) {
        await Promise.race(activeChunks)
        startAvailableChunks()
      }

      job.fullBookAudioDone = true
      job.fullBookAudioStatusText = 'Book audio ready.'
      notify(job)
    } catch (err) {
      job.fullBookAudioError = err
      job.fullBookAudioStatusText = err.message || 'Could not prepare book audio.'
      notify(job)
      throw err
    }
  })()

  void job.fullBookAudioPromise.catch(() => {})
  return job.fullBookAudioPromise
}

function createBookPreparationJob({ book, sourceUrl = '' }) {
  const key = bookPreparationKey(book, sourceUrl)
  const job = {
    key,
    book,
    sourceUrl,
    pdfInfo: null,
    pdfError: null,
    pdfStatusText: sourceUrl
      ? 'Checking your PDF link...'
      : `Converting "${book.title}" into a podcast...`,
    hookInfo: null,
    hookError: null,
    bookClipUrls: [],
    bookAudioClips: [],
    fullBookAudioStarted: false,
    fullBookAudioDone: false,
    fullBookAudioError: null,
    fullBookAudioStatusText: '',
    listeners: new Set(),
    subscribe(listener) {
      this.listeners.add(listener)
      listener(this)
      return () => this.listeners.delete(listener)
    },
  }

  job.hookPromise = generateBookHook({ title: book.title })
    .then((hookInfo) => {
      job.hookInfo = hookInfo
      notify(job)
      return hookInfo
    })
    .catch((err) => {
      job.hookError = err
      notify(job)
      throw err
    })

  job.pdfPromise = findAndStorePdf({
    title: book.title,
    author: book.authors,
    expectedPages: book.expectedPages,
    sourceUrl,
    onProgress: (text) => {
      job.pdfStatusText = text
      notify(job)
    },
  })
    .then((pdfInfo) => {
      job.pdfInfo = pdfInfo
      job.pdfStatusText = 'Saved PDF + text to library.'
      notify(job)
      startFullBookAudio(job, pdfInfo)
      return pdfInfo
    })
    .catch((err) => {
      job.pdfError = err
      job.pdfStatusText = err.message || 'Could not save the book.'
      notify(job)
      throw err
    })

  void job.hookPromise.catch(() => {})
  void job.pdfPromise.catch(() => {})

  jobs.set(key, job)
  return job
}

export function startBookPreparation({ book, sourceUrl = '' }) {
  const key = bookPreparationKey(book, sourceUrl)
  if (!key) return null

  return jobs.get(key) || createBookPreparationJob({ book, sourceUrl })
}

export function getBookPreparation(key) {
  return jobs.get(key) || null
}
