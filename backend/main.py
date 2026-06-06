"""
Podcastify backend (thin HTTP layer).

This file only wires HTTP routes to the underlying modules:
    pdf_finder  -> finds a readable PDF and extracts its text
    r2_storage  -> uploads PDF/text bytes to the Cloudflare R2 bucket

Run locally with:
    uvicorn main:app --reload --port 8001
"""
from __future__ import annotations

import asyncio
import json
import re
from uuid import uuid4
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from book_podcast_pipeline import (
    BookPodcastPipelineError,
    generate_book_chunk_queue_item,
    stream_book_chunk_queue_items,
)
from hook_generator import HookGenerationError, generate_book_hook
from pdf_finder import (
    PdfNotFoundError,
    book_folder_key,
    find_book_pdf,
    storage_key,
    text_storage_key,
)
from r2_storage import (
    r2_configured,
    upload_jsonl_text_to_r2,
    upload_pdf_to_r2,
    upload_text_to_r2,
)
from text_chunker import (
    TEXT_CHUNK_SIZE,
    build_text_chunks_jsonl,
    text_chunks_storage_key,
)

app = FastAPI(title="Podcastify API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class FindPdfRequest(BaseModel):
    title: str
    author: str = ""
    expected_pages: Optional[int] = None
    source_url: Optional[str] = None


class GenerateHookRequest(BaseModel):
    title: str


class RenderHookAudioRequest(BaseModel):
    title: str
    hook: str


class RenderHookLineAudioRequest(BaseModel):
    title: str
    speaker: str
    text: str
    line_index: int = 0


class RenderBookChunkAudioRequest(BaseModel):
    title: str
    text_chunks_key: str
    chunk_index: int
    line_batch_size: int = 4


def audio_storage_key(title: str, clip_name: str = "hook") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "book"
    return f"audio/{slug}/{clip_name}-{uuid4().hex}.mp3"


@app.post("/api/find-pdf")
async def find_pdf(req: FindPdfRequest):
    """
    Find a text-extractable book PDF and store the PDF + extracted text in R2.

    Returns the R2 object key + public URL (when configured) along with light
    metadata about the PDF and text extraction.
    """
    try:
        found = await find_book_pdf(
            req.title,
            req.author,
            req.expected_pages,
            req.source_url,
        )
    except PdfNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    pdf_key = storage_key(req.title, req.author)
    text_key = text_storage_key(req.title, req.author)
    text_chunks_key = text_chunks_storage_key(book_folder_key(req.title, req.author))

    pdf_upload = await upload_pdf_to_r2(found.content, pdf_key)
    if not pdf_upload.get("uploaded"):
        raise HTTPException(
            status_code=502,
            detail=f"Found a readable PDF but could not store it: {pdf_upload.get('reason')}",
        )

    text_upload = await upload_text_to_r2(found.extracted_text, text_key)
    if not text_upload.get("uploaded"):
        raise HTTPException(
            status_code=502,
            detail=f"Extracted text but could not store it: {text_upload.get('reason')}",
        )

    text_chunks_jsonl, text_chunk_count = build_text_chunks_jsonl(found.extracted_text)
    text_chunks_upload = await upload_jsonl_text_to_r2(text_chunks_jsonl, text_chunks_key)
    if not text_chunks_upload.get("uploaded"):
        raise HTTPException(
            status_code=502,
            detail=(
                "Stored extracted text but could not store text chunks: "
                f"{text_chunks_upload.get('reason')}"
            ),
        )

    return {
        "status": "success",
        "title": req.title,
        "author": req.author,
        "key": pdf_upload["key"],
        "url": pdf_upload["url"],
        "text_key": text_upload["key"],
        "text_url": text_upload["url"],
        "text_chunks_key": text_chunks_upload["key"],
        "text_chunks_url": text_chunks_upload["url"],
        "text_chunk_count": text_chunk_count,
        "text_chunk_size": TEXT_CHUNK_SIZE,
        "pages": found.pages,
        "size_mb": found.size_mb,
        "source_url": found.source_url,
        "expected_pages": req.expected_pages,
        "manual_source": bool(req.source_url),
        "text_chars": len(found.extracted_text),
        "text_quality_score": found.text_quality_score,
        "text_pages_checked": found.text_pages_checked,
        "diagnostics": found.diagnostics,
        "ocr_used": False,
    }


@app.post("/api/generate-hook")
async def generate_hook(req: GenerateHookRequest):
    """Generate the cold-open hook shown before full-book podcast generation."""
    try:
        generated = await generate_book_hook(req.title)
    except HookGenerationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "book_name": generated.book_name,
        "hook": generated.hook,
        "model": generated.model,
    }


@app.post("/api/render-hook-audio")
async def render_hook_audio(req: RenderHookAudioRequest):
    """Render generated hook dialogue to MP3, upload it to R2, and return its URL."""
    try:
        from tts.make_audio import render_hook, upload_to_r2

        audio = await asyncio.to_thread(render_hook, req.hook)
        audio_key = audio_storage_key(req.title)
        audio_url = await asyncio.to_thread(upload_to_r2, audio, audio_key)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not render hook audio: {exc}") from exc

    return {
        "audio_key": audio_key,
        "audio_url": audio_url,
    }


@app.post("/api/render-hook-line-audio")
async def render_hook_line_audio(req: RenderHookLineAudioRequest):
    """Render one generated hook dialogue line to MP3 so playback can start sooner."""
    try:
        from tts.make_audio import VOICES, make_audio, upload_to_r2

        speaker = req.speaker.upper().strip()
        text = req.text.strip()
        if speaker not in VOICES:
            raise ValueError(f"Unsupported hook speaker: {req.speaker}")
        if not text:
            raise ValueError("Hook line text is required")

        audio = await asyncio.to_thread(make_audio, text, VOICES[speaker])
        audio_key = audio_storage_key(req.title, f"hook-line-{req.line_index + 1:03d}")
        audio_url = await asyncio.to_thread(upload_to_r2, audio, audio_key)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not render hook line audio: {exc}") from exc

    return {
        "audio_key": audio_key,
        "audio_url": audio_url,
        "line_index": req.line_index,
    }


@app.post("/api/render-book-chunk-audio")
async def render_book_chunk_audio(req: RenderBookChunkAudioRequest):
    """Generate one full-book chunk script, render it to MP3, upload it, and return its URL."""
    try:
        item = await generate_book_chunk_queue_item(
            book_title=req.title,
            text_chunks_key=req.text_chunks_key,
            chunk_index=req.chunk_index,
        )
    except BookPodcastPipelineError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not render book chunk audio: {exc}",
        ) from exc

    return {
        "chunk_index": item.chunk_index,
        "audio_key": item.audio_key,
        "audio_url": item.audio_url,
        "script": item.script,
        "model": item.model,
        "target_words": item.target_words,
    }


@app.post("/api/stream-book-chunk-audio")
async def stream_book_chunk_audio(req: RenderBookChunkAudioRequest):
    """
    Stream small 3-4 dialogue-line audio clips for one book chunk.

    Each response line is JSON. Successful lines include an `audio_url` that the
    frontend can append to its playback queue immediately.
    """

    async def events():
        try:
            async for item in stream_book_chunk_queue_items(
                book_title=req.title,
                text_chunks_key=req.text_chunks_key,
                chunk_index=req.chunk_index,
                line_batch_size=req.line_batch_size,
            ):
                yield json.dumps(
                    {
                        "chunk_index": item.chunk_index,
                        "part_index": item.part_index,
                        "audio_key": item.audio_key,
                        "audio_url": item.audio_url,
                        "script": item.script,
                        "model": item.model,
                        "target_words": item.target_words,
                    }
                ) + "\n"
        except BookPodcastPipelineError as exc:
            yield json.dumps({"error": str(exc)}) + "\n"
        except Exception as exc:
            yield json.dumps({"error": f"Could not stream book chunk audio: {exc}"}) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson")


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "r2_configured": r2_configured()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)
