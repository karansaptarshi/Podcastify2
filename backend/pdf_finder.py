"""
Find a book PDF via Serper Google search, validate it, extract text.

Public API: find_book_pdf, storage_key, text_storage_key, PdfNotFoundError
"""
from __future__ import annotations

import os
import re
import urllib.parse
from dataclasses import dataclass

import fitz
import httpx
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()

_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
_SERPER_URL = "https://google.serper.dev/search"
_MIN_PDF_BYTES = 100_000
_MAX_PDF_BYTES = 150 * 1024 * 1024
_MIN_PAGES = 50
_MIN_FULL_TEXT_CHARS = 5_000
_MIN_SAMPLE_CHARS_PER_PAGE = 80
_MAX_TRIES = 12
_MAX_SERPER_RESULTS = 10
_PARTIAL_MARKERS = ("chapter", "sample", "preview", "excerpt", "summary")


class PdfNotFoundError(Exception):
    pass


@dataclass
class FoundPdf:
    content: bytes
    source_url: str
    pages: int
    extracted_text: str
    text_quality_score: float
    text_pages_checked: int
    diagnostics: list[str]

    @property
    def size_mb(self) -> float:
        return round(len(self.content) / (1024 * 1024), 2)


# --- R2 keys (used by main.py) ---

def safe_title(title: str) -> str:
    return re.sub(r"[^\w\s-]", "", title)[:50].strip()


def _slug(value: str) -> str:
    return safe_title(value).lower().replace(" ", "_") or "book"


def book_folder_key(title: str, author: str = "") -> str:
    label = f"{title} by {author}" if author.strip() else title
    return f"books/{_slug(label)}"


def storage_key(title: str, author: str = "") -> str:
    return f"{book_folder_key(title, author)}/source.pdf"


def text_storage_key(title: str, author: str = "") -> str:
    return f"{book_folder_key(title, author)}/text.txt"


# --- helpers ---

def _log(diagnostics: list[str], msg: str) -> None:
    print(f"[pdf_finder] {msg}")
    diagnostics.append(msg)


def _clean_text(text: str) -> str:
    lines = (re.sub(r"\s+", " ", line).strip() for line in text.splitlines())
    return "\n".join(line for line in lines if line)


def _first_author(author: str) -> str:
    return re.sub(r"\s+", " ", author.split(",")[0] if author else "").strip()


def _search_query(title: str, author: str) -> str:
    title = re.sub(r"\s+", " ", title).strip()
    author = _first_author(author)
    if author and title.lower().endswith(author.lower()):
        title = title[: -len(author)].strip()
    return " ".join(part for part in (title, author) if part)


def _is_pdf_url(url: str) -> bool:
    path = urllib.parse.unquote_plus(urllib.parse.urlparse(url).path).lower()
    return path.endswith(".pdf") or ".pdf/" in path


def _looks_like_preview(url: str) -> bool:
    words = re.sub(r"[^a-z0-9]+", " ", urllib.parse.unquote_plus(url).lower())
    return any(m in words for m in _PARTIAL_MARKERS)


def _text_quality_score(text: str) -> float:
    if not text:
        return 0.0
    words = len(re.findall(r"[A-Za-z]{3,}", text))
    return round(min(len(text) / 6000, 1) * 0.5 + min(words / 800, 1) * 0.5, 3)


def _min_pages(expected_pages: int | None) -> int:
    if not expected_pages:
        return _MIN_PAGES
    return min(_MIN_PAGES, max(10, int(expected_pages * 0.7)))


# --- Serper + candidate discovery ---

async def _serper_search(client: httpx.AsyncClient, query: str, diagnostics: list[str]) -> list[str]:
    api_key = os.getenv("SERPER_API_KEY", "").strip()
    if not api_key:
        _log(diagnostics, "SERPER_API_KEY is not configured")
        return []
    try:
        resp = await client.post(
            _SERPER_URL,
            headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
            json={"q": query, "num": _MAX_SERPER_RESULTS},
            timeout=12.0,
        )
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        _log(diagnostics, f"serper failed: {exc}")
        return []

    links = []
    for row in resp.json().get("organic", []):
        if link := row.get("link"):
            links.append(link)
    return links


async def _pdf_links_on_page(client: httpx.AsyncClient, url: str) -> list[str]:
    try:
        resp = await client.get(url, timeout=12.0)
        resp.raise_for_status()
    except httpx.HTTPError:
        return []
    if "html" not in resp.headers.get("content-type", "").lower():
        return []
    out = []
    for a in BeautifulSoup(resp.text, "html.parser").find_all("a", href=True):
        href = urllib.parse.urljoin(str(resp.url), a["href"])
        if _is_pdf_url(href):
            out.append(href)
    return out


async def _collect_candidates(
    client: httpx.AsyncClient, title: str, author: str, diagnostics: list[str]
) -> list[str]:
    base = _search_query(title, author)
    if not base:
        return []

    seen: set[str] = set()
    candidates: list[str] = []

    def add(url: str) -> bool:
        url = url.strip()
        if not url.startswith("http") or url in seen or _looks_like_preview(url):
            return False
        seen.add(url)
        candidates.append(url)
        return len(candidates) >= _MAX_TRIES

    for query in (f"{base} pdf", f"{base} full pdf"):
        for url in await _serper_search(client, query, diagnostics):
            if add(url):
                return candidates
            if not _is_pdf_url(url):
                for pdf_url in await _pdf_links_on_page(client, url):
                    if add(pdf_url):
                        return candidates
    return candidates


# --- download, validate, extract ---

def _extract_all_text(doc: fitz.Document) -> tuple[str, float] | None:
    parts = []
    for page in doc:
        try:
            parts.append(page.get_text("text") or "")
        except Exception:
            parts.append("")
    text = _clean_text("\n".join(parts))
    if len(text) < _MIN_FULL_TEXT_CHARS:
        return None
    return text, _text_quality_score(text)


def _sample_has_text(doc: fitz.Document) -> tuple[bool, int]:
    """Quick check: a few spread-out pages have readable text."""
    n = doc.page_count
    if n <= 0:
        return False, 0
    if n <= 5:
        indices = list(range(n))
    else:
        step = max(1, n // 5)
        indices = list(range(0, n, step))[:5]

    total_chars = 0
    for i in indices:
        try:
            total_chars += len((doc.load_page(i).get_text("text") or "").strip())
        except Exception:
            pass
    avg = total_chars / len(indices) if indices else 0
    return avg >= _MIN_SAMPLE_CHARS_PER_PAGE, len(indices)


async def _try_url(
    client: httpx.AsyncClient,
    url: str,
    expected_pages: int | None,
    diagnostics: list[str],
    *,
    trust_url: bool = False,
) -> FoundPdf | None:
    if not trust_url and _looks_like_preview(url):
        _log(diagnostics, f"skip preview-looking url: {url[:80]}")
        return None

    print(f"[pdf_finder] trying: {url[:100]}")
    try:
        resp = await client.get(url, timeout=60.0)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        _log(diagnostics, f"download failed: {url[:80]} ({exc})")
        return None

    content = resp.content
    ctype = resp.headers.get("content-type", "").lower()
    if "pdf" not in ctype and not _is_pdf_url(url):
        _log(diagnostics, f"not pdf: {url[:80]}")
        return None
    if not _MIN_PDF_BYTES <= len(content) <= _MAX_PDF_BYTES:
        _log(diagnostics, f"bad size {len(content)}: {url[:80]}")
        return None

    try:
        doc = fitz.open(stream=content, filetype="pdf")
    except Exception:
        _log(diagnostics, f"unparseable: {url[:80]}")
        return None

    try:
        pages = doc.page_count
        if pages < _min_pages(expected_pages):
            _log(diagnostics, f"too few pages ({pages}): {url[:80]}")
            return None

        ok, sampled = _sample_has_text(doc)
        if not ok:
            _log(diagnostics, f"not enough extractable text: {url[:80]}")
            return None

        extracted = _extract_all_text(doc)
        if not extracted:
            _log(diagnostics, f"full text extraction failed: {url[:80]}")
            return None
        text, score = extracted
        print(f"[pdf_finder] accepted {pages} pages from {url[:80]}")
        return FoundPdf(content, url, pages, text, score, sampled, diagnostics)
    finally:
        doc.close()


async def find_book_pdf(
    title: str, author: str = "", expected_pages: int | None = None, source_url: str | None = None
) -> FoundPdf:
    diagnostics: list[str] = []
    async with httpx.AsyncClient(headers={"User-Agent": _USER_AGENT}, follow_redirects=True) as client:
        if source_url:
            if found := await _try_url(client, source_url, expected_pages, diagnostics, trust_url=True):
                return found
            raise PdfNotFoundError(
                "The provided PDF URL was not usable. "
                + ("; ".join(diagnostics[-3:]) if diagnostics else "")
            )

        candidates = await _collect_candidates(client, title, author, diagnostics)
        if not candidates:
            raise PdfNotFoundError("No PDF links found from search")

        for url in candidates:
            if found := await _try_url(client, url, expected_pages, diagnostics):
                return found

    raise PdfNotFoundError(
        "No usable PDF found. " + ("; ".join(diagnostics[-3:]) if diagnostics else "")
    )
