"""
Podcastify backend (thin HTTP layer).

This file only wires HTTP routes to the underlying modules:
    pdf_finder  -> finds a readable PDF and extracts its text
    r2_storage  -> uploads PDF/text bytes to the Cloudflare R2 bucket

Run locally with:
    uvicorn main:app --reload --port 8001
"""
from __future__ import annotations

from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from hook_generator import HookGenerationError, generate_book_hook
from pdf_finder import PdfNotFoundError, find_book_pdf, storage_key, text_storage_key
from r2_storage import r2_configured, upload_pdf_to_r2, upload_text_to_r2

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


class GenerateHookRequest(BaseModel):
    title: str


@app.post("/api/find-pdf")
async def find_pdf(req: FindPdfRequest):
    """
    Find a text-extractable book PDF and store the PDF + extracted text in R2.

    Returns the R2 object key + public URL (when configured) along with light
    metadata about the PDF and text extraction.
    """
    try:
        found = await find_book_pdf(req.title, req.author, req.expected_pages)
    except PdfNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    pdf_key = storage_key(req.title, req.author)
    text_key = text_storage_key(req.title, req.author)

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

    return {
        "status": "success",
        "title": req.title,
        "author": req.author,
        "key": pdf_upload["key"],
        "url": pdf_upload["url"],
        "text_key": text_upload["key"],
        "text_url": text_upload["url"],
        "pages": found.pages,
        "size_mb": found.size_mb,
        "source_url": found.source_url,
        "expected_pages": req.expected_pages,
        "text_chars": len(found.extracted_text),
        "text_quality_score": found.text_quality_score,
        "text_pages_checked": found.text_pages_checked,
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


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "r2_configured": r2_configured()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)
