"""
Find a readable full-book PDF from the web.

Public API used by the backend:
    search_for_pdf(query) -> list[str]
    download_pdf(url) -> bytes | None
    find_book_pdf(title, author, expected_pages) -> FoundPdf
"""
from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass
from io import BytesIO

import httpx
from bs4 import BeautifulSoup
from PyPDF2 import PdfReader

_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

_MIN_PDF_BYTES = 100_000
_MAX_CANDIDATES = 10
_MAX_DOWNLOAD_ATTEMPTS = 5
_MAX_TEXT_ATTEMPTS = 3
_TEXT_SAMPLE_PAGES = 8
_MIN_FULL_BOOK_PAGES = 50
_EXPECTED_PAGE_MARGIN = 0.35
_MIN_SAMPLE_CHARS = 1_000
_MIN_FULL_TEXT_CHARS = 5_000
_MIN_TEXT_QUALITY_SCORE = 0.55

_PARTIAL_URL_MARKERS = ("chapter", "sample", "preview", "excerpt", "extract", "summary")
_PARTIAL_TEXT_PHRASES = (
    "sample chapter",
    "book preview",
    "preview only",
    "free preview",
    "excerpt from",
    "this excerpt",
    "continue reading",
)


class PdfNotFoundError(Exception):
    """Raised when no usable PDF could be found for a book."""


@dataclass
class FoundPdf:
    content: bytes
    source_url: str
    pages: int
    extracted_text: str
    text_quality_score: float
    text_pages_checked: int

    @property
    def size_mb(self) -> float:
        return round(len(self.content) / (1024 * 1024), 2)


@dataclass
class ExtractedText:
    text: str
    quality_score: float
    pages_checked: int


@dataclass
class _DownloadedPdf:
    content: bytes
    pages: int


def safe_title(title: str) -> str:
    """Filesystem/key-safe version of a book title."""
    return re.sub(r"[^\w\s-]", "", title)[:50].strip()


def _slug(value: str) -> str:
    return safe_title(value).lower().replace(" ", "_") or "book"


def book_folder_key(title: str, author: str = "") -> str:
    """R2 prefix for everything generated from one book."""
    label = f"{title} by {author}" if author.strip() else title
    return f"books/{_slug(label)}"


def storage_key(title: str, author: str = "") -> str:
    return f"{book_folder_key(title, author)}/source.pdf"


def text_storage_key(title: str, author: str = "") -> str:
    return f"{book_folder_key(title, author)}/text.txt"


def _read_pdf(content: bytes) -> PdfReader | None:
    try:
        return PdfReader(BytesIO(content))
    except Exception:  # noqa: BLE001 - parse failures mean the PDF is unusable.
        return None


def _clean_text(text: str) -> str:
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def _text_quality_score(text: str) -> float:
    if not text:
        return 0.0

    printable = sum(1 for char in text if char.isprintable() or char.isspace())
    letters_spaces = sum(1 for char in text if char.isalpha() or char.isspace())
    words = re.findall(r"[A-Za-z]{3,}", text)

    return round(
        min(len(text) / 6_000, 1.0) * 0.35
        + (printable / len(text)) * 0.20
        + (letters_spaces / len(text)) * 0.20
        + min(len(words) / 800, 1.0) * 0.25,
        3,
    )


def extract_text_from_pdf(content: bytes, max_pages: int | None = None) -> ExtractedText | None:
    """Extract text and reject empty/garbled output."""
    reader = _read_pdf(content)
    if not reader:
        return None

    page_limit = min(len(reader.pages), max_pages) if max_pages else len(reader.pages)
    page_text: list[str] = []

    for page in reader.pages[:page_limit]:
        try:
            page_text.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001 - skip unreadable pages, keep checking others.
            page_text.append("")

    text = _clean_text("\n".join(page_text))
    score = _text_quality_score(text)
    min_chars = _MIN_SAMPLE_CHARS if max_pages else _MIN_FULL_TEXT_CHARS

    if len(text) < min_chars or score < _MIN_TEXT_QUALITY_SCORE:
        return None

    return ExtractedText(text=text, quality_score=score, pages_checked=page_limit)


def _dedupe_urls(urls: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for url in urls:
        if url.startswith("http") and url not in seen:
            seen.add(url)
            unique.append(url)
    return unique


def _extract_search_links(html: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    links: list[str] = []

    links.extend(
        href
        for link in soup.find_all("a", class_="result__url")
        if (href := link.get("href", ""))
    )
    links.extend(
        href
        for link in soup.find_all("a", class_="result__a")
        if ".pdf" in (href := link.get("href", "")).lower()
    )

    # DuckDuckGo often wraps outbound URLs in ?uddg=<encoded url>.
    for link in soup.find_all("a"):
        href = link.get("href", "")
        if "pdf" not in href.lower():
            continue
        if "uddg=" in href:
            query = urllib.parse.urlparse(href).query
            links.extend(urllib.parse.parse_qs(query).get("uddg", []))
        elif href.startswith("http"):
            links.append(href)

    return _dedupe_urls(links)


async def search_for_pdf(query: str) -> list[str]:
    """Search DuckDuckGo HTML results for candidate PDF URLs."""
    search_url = (
        "https://html.duckduckgo.com/html/?q="
        f"{urllib.parse.quote_plus(query + ' filetype:pdf')}"
    )

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(
                search_url,
                headers={"User-Agent": _USER_AGENT},
                timeout=15.0,
                follow_redirects=True,
            )
        except httpx.HTTPError as exc:
            print(f"[pdf_finder] search error: {exc}")
            return []

    links = _extract_search_links(response.text)
    print(f"[pdf_finder] found {len(links)} candidate links for: {query}")
    return links[:_MAX_CANDIDATES]


async def _download_pdf(url: str) -> _DownloadedPdf | None:
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(
                url,
                headers={"User-Agent": _USER_AGENT},
                timeout=60.0,
                follow_redirects=True,
            )
        except httpx.HTTPError as exc:
            print(f"[pdf_finder] download error for {url[:80]}: {exc}")
            return None

    content_type = response.headers.get("content-type", "").lower()
    if "pdf" not in content_type and not url.lower().endswith(".pdf"):
        return None
    if len(response.content) < _MIN_PDF_BYTES:
        return None

    reader = _read_pdf(response.content)
    if not reader:
        return None

    return _DownloadedPdf(content=response.content, pages=len(reader.pages))


async def download_pdf(url: str) -> bytes | None:
    """Download a URL and return bytes only if it is a valid PDF."""
    downloaded = await _download_pdf(url)
    return downloaded.content if downloaded else None


def _looks_partial_by_url(url: str) -> bool:
    decoded = urllib.parse.unquote_plus(url).lower()
    words = re.sub(r"[^a-z0-9]+", " ", decoded)
    return any(marker in words for marker in _PARTIAL_URL_MARKERS)


def _partial_text_phrase(text: str) -> str | None:
    lower_text = text.lower()
    return next((phrase for phrase in _PARTIAL_TEXT_PHRASES if phrase in lower_text), None)


def _page_rejection_reason(pages: int, expected_pages: int | None) -> str | None:
    if pages < _MIN_FULL_BOOK_PAGES:
        return f"only {pages} pages"
    if not expected_pages:
        return None

    margin = max(30, round(expected_pages * _EXPECTED_PAGE_MARGIN))
    min_pages = max(_MIN_FULL_BOOK_PAGES, expected_pages - margin)
    max_pages = expected_pages + margin

    if pages < min_pages:
        return f"{pages} pages is too short for expected {expected_pages}"
    if pages > max_pages:
        return f"{pages} pages is too long for expected {expected_pages}"
    return None


def _reject(reason: str, url: str) -> None:
    print(f"[pdf_finder] rejected PDF {reason}: {url[:80]}")


def _extract_full_text(content: bytes, url: str) -> ExtractedText | None:
    sample = extract_text_from_pdf(content, max_pages=_TEXT_SAMPLE_PAGES)
    if not sample:
        _reject("with poor text extraction", url)
        return None

    if phrase := _partial_text_phrase(sample.text):
        _reject(f"with partial-book text ({phrase})", url)
        return None

    full_text = extract_text_from_pdf(content)
    if not full_text:
        print(f"[pdf_finder] sample passed but full extraction failed: {url[:80]}")
    return full_text


async def _candidate_urls(title: str, author: str) -> list[str]:
    for query in (f"{title} {author} book pdf".strip(), f"{title} pdf download free"):
        candidates = await search_for_pdf(query)
        if candidates:
            return candidates
    return []


async def find_book_pdf(
    title: str,
    author: str = "",
    expected_pages: int | None = None,
) -> FoundPdf:
    """Find a valid full-book PDF with readable extractable text."""
    candidates = await _candidate_urls(title, author)
    if not candidates:
        raise PdfNotFoundError("No PDF sources found for this book")

    text_attempts = 0
    for url in candidates[:_MAX_DOWNLOAD_ATTEMPTS]:
        if _looks_partial_by_url(url):
            _reject("from partial-looking source URL", url)
            continue

        pdf = await _download_pdf(url)
        if not pdf:
            continue

        text_attempts += 1
        if reason := _page_rejection_reason(pdf.pages, expected_pages):
            _reject(f"by page count ({reason})", url)
            if text_attempts >= _MAX_TEXT_ATTEMPTS:
                break
            continue

        text = _extract_full_text(pdf.content, url)
        if not text:
            if text_attempts >= _MAX_TEXT_ATTEMPTS:
                break
            continue

        return FoundPdf(
            content=pdf.content,
            source_url=url,
            pages=pdf.pages,
            extracted_text=text.text,
            text_quality_score=text.quality_score,
            text_pages_checked=text.pages_checked,
        )

    # TODO: OCR fallback belongs here:
    # 1. Pick the best downloaded PDF candidate.
    # 2. Render its pages to images.
    # 3. Run OCR with Tesseract or a cloud OCR provider.
    # 4. Clean/score the OCR text, then return FoundPdf with ocr_used=True.
    if text_attempts:
        raise PdfNotFoundError(
            "Found PDFs, but none had readable extractable text. OCR fallback is not configured yet."
        )

    raise PdfNotFoundError(
        "Could not download a valid readable PDF. The book may not be freely available."
    )
