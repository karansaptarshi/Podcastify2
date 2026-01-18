"""
Smart Chapter 1 Extraction using LLM

Strategy:
1. Extract text snippets from first ~50 pages
2. Pre-filter to identify front matter (TOC, copyright, etc.)
3. Use LLM to identify where Chapter 1 starts and ends
4. Extract those pages as a separate PDF

This approach works because:
- LLMs understand context and can identify chapter patterns humans use
- Pre-filtering removes obvious front matter before LLM analysis
- Handles "Chapter 1", "Chapter One", "CHAPTER I", "1.", "Part One", etc.
"""

import httpx
import json
import re
from io import BytesIO
from PyPDF2 import PdfReader, PdfWriter
from pathlib import Path


# Patterns that indicate FRONT MATTER (pages to skip)
FRONT_MATTER_PATTERNS = [
    r'table\s+of\s+contents',
    r'^\s*contents\s*$',
    r'copyright\s*©',
    r'all\s+rights\s+reserved',
    r'isbn[\s\-:]+\d',
    r'library\s+of\s+congress',
    r'published\s+by',
    r'first\s+(edition|published|printing)',
    r'printed\s+in\s+(the\s+)?(united\s+states|usa|uk|china)',
    r'dedication',
    r'acknowledgments?',
    r'^\s*preface\s*$',
    r'^\s*foreword\s*$',
    r'^\s*introduction\s*$',
    r'about\s+the\s+author',
    r'also\s+by\s+',
    r'praise\s+for\s+',
    r'^\s*index\s*$',
    r'\.{3,}\s*\d+',  # TOC pattern: "Chapter 1 .......... 23"
]

# Patterns that indicate CHAPTER START
CHAPTER_START_PATTERNS = [
    r'^\s*chapter\s+(one|1|i)\s*$',
    r'^\s*chapter\s+(one|1|i)\s*[:\-]',
    r'^\s*chapter\s+1\b',
    r'^\s*part\s+(one|1|i)\s*$',
    r'^\s*1\s*$',  # Just "1" alone on a line
    r'^\s*one\s*$',  # Just "ONE" alone
]

# Patterns for NEXT CHAPTER (to find where chapter 1 ends)
NEXT_CHAPTER_PATTERNS = [
    r'^\s*chapter\s+(two|2|ii)\s*',
    r'^\s*chapter\s+2\b',
    r'^\s*part\s+(two|2|ii)\s*',
    r'^\s*2\s*$',
    r'^\s*two\s*$',
]


def is_front_matter_page(text: str) -> bool:
    """Check if page text looks like front matter"""
    text_lower = text.lower()
    
    for pattern in FRONT_MATTER_PATTERNS:
        if re.search(pattern, text_lower, re.IGNORECASE | re.MULTILINE):
            return True
    
    # Also check for TOC-like structure (many page numbers)
    page_number_matches = re.findall(r'\b\d{1,3}\s*$', text, re.MULTILINE)
    if len(page_number_matches) > 5:  # Looks like TOC
        return True
    
    return False


def is_chapter_start_page(text: str) -> tuple[bool, str]:
    """Check if page looks like start of Chapter 1. Returns (is_chapter, title)"""
    lines = text.split('\n')
    
    # Check first 15 lines for chapter markers
    for i, line in enumerate(lines[:15]):
        line_stripped = line.strip()
        
        for pattern in CHAPTER_START_PATTERNS:
            if re.search(pattern, line_stripped, re.IGNORECASE):
                # Try to extract title from next non-empty line
                title = "Chapter 1"
                for next_line in lines[i+1:i+5]:
                    next_stripped = next_line.strip()
                    if next_stripped and len(next_stripped) > 3 and len(next_stripped) < 100:
                        if not re.search(r'^\d+$', next_stripped):  # Not just a number
                            title = f"Chapter 1: {next_stripped}"
                            break
                return True, title
    
    return False, ""


def is_next_chapter_page(text: str) -> bool:
    """Check if page looks like start of Chapter 2 or later"""
    lines = text.split('\n')
    
    for line in lines[:15]:
        line_stripped = line.strip()
        for pattern in NEXT_CHAPTER_PATTERNS:
            if re.search(pattern, line_stripped, re.IGNORECASE):
                return True
    
    return False


async def extract_page_snippets(pdf_content: bytes, max_pages: int = 50) -> list[dict]:
    """
    Extract text snippets from the first N pages of a PDF.
    Also marks pages as front_matter, chapter_start, etc.
    """
    reader = PdfReader(BytesIO(pdf_content))
    total_pages = len(reader.pages)
    pages_to_scan = min(max_pages, total_pages)
    
    snippets = []
    for i in range(pages_to_scan):
        try:
            text = reader.pages[i].extract_text() or ""
            snippet = text[:800].strip()
            
            # Analyze the page
            is_front = is_front_matter_page(text)
            is_ch1, ch1_title = is_chapter_start_page(text)
            is_ch2 = is_next_chapter_page(text)
            
            snippets.append({
                "page": i + 1,
                "snippet": snippet,
                "text_length": len(text),
                "full_text": text,
                "is_front_matter": is_front,
                "is_chapter_start": is_ch1,
                "chapter_title": ch1_title,
                "is_next_chapter": is_ch2,
            })
        except Exception as e:
            print(f"Error extracting page {i+1}: {e}")
            snippets.append({
                "page": i + 1,
                "snippet": "",
                "text_length": 0,
                "full_text": "",
                "is_front_matter": False,
                "is_chapter_start": False,
                "chapter_title": "",
                "is_next_chapter": False,
            })
    
    return snippets


def find_chapter_boundaries_heuristic(snippets: list[dict]) -> dict:
    """
    Find chapter boundaries using pre-analyzed snippets.
    This is fast and doesn't need LLM.
    """
    chapter1_start = None
    chapter1_end = None
    chapter1_title = "Chapter 1"
    
    # First pass: find explicit chapter markers
    for s in snippets:
        if chapter1_start is None:
            # Skip front matter
            if s["is_front_matter"]:
                print(f"  Page {s['page']}: Front matter, skipping")
                continue
            
            # Found chapter start!
            if s["is_chapter_start"]:
                chapter1_start = s["page"]
                chapter1_title = s["chapter_title"] or "Chapter 1"
                print(f"  Page {s['page']}: Chapter 1 starts here! Title: {chapter1_title}")
                continue
        
        # Look for chapter 2 (end of chapter 1)
        if chapter1_start is not None and chapter1_end is None:
            if s["is_next_chapter"]:
                chapter1_end = s["page"] - 1
                print(f"  Page {s['page']}: Next chapter found, Chapter 1 ends at page {chapter1_end}")
                break
    
    # If no explicit chapter 1 found, find first non-front-matter page with substantial text
    if chapter1_start is None:
        print("  No explicit Chapter 1 marker found, looking for content start...")
        for s in snippets:
            if not s["is_front_matter"] and s["text_length"] > 500:
                # Check it's not just more TOC or index
                if not re.search(r'\.{3,}\s*\d+', s["snippet"]):
                    chapter1_start = s["page"]
                    print(f"  Page {s['page']}: Content appears to start here")
                    break
    
    # Still nothing? Default to page 10 (skip first 9 pages of front matter)
    if chapter1_start is None:
        chapter1_start = min(10, len(snippets))
        print(f"  Defaulting to page {chapter1_start}")
    
    # If no chapter 2 found, limit to 25 pages
    if chapter1_end is None:
        chapter1_end = min(chapter1_start + 25, len(snippets))
        print(f"  No Chapter 2 found, limiting to page {chapter1_end}")
    
    return {
        "chapter1_start": chapter1_start,
        "chapter1_end": chapter1_end,
        "chapter1_title": chapter1_title,
        "reasoning": "Heuristic detection"
    }


async def identify_chapter_boundaries_llm(
    snippets: list[dict],
    openrouter_api_key: str,
    book_title: str = ""
) -> dict | None:
    """
    Use LLM as a backup to verify/find chapter boundaries.
    Returns None if LLM fails.
    """
    if not openrouter_api_key:
        return None
    
    # Build summary excluding obvious front matter
    pages_summary = []
    for s in snippets:
        if s["is_front_matter"]:
            pages_summary.append(f"PAGE {s['page']}: [FRONT MATTER - skip]")
        else:
            preview = s["snippet"][:250].replace("\n", " ").strip()
            if preview:
                marker = ""
                if s["is_chapter_start"]:
                    marker = " [LIKELY CHAPTER 1 START]"
                elif s["is_next_chapter"]:
                    marker = " [LIKELY CHAPTER 2 START]"
                pages_summary.append(f"PAGE {s['page']}{marker}: {preview}")
    
    pages_text = "\n\n".join(pages_summary[:30])  # Limit to first 30 entries
    
    prompt = f"""Find where Chapter 1 STARTS and ENDS in this book.

Book: {book_title if book_title else "Unknown"}

Page summaries (I've marked front matter to skip):

{pages_text}

IMPORTANT:
- Chapter 1 is the FIRST MAIN CHAPTER with actual book content
- It is NOT the table of contents, index, preface, introduction, or any front matter
- Look for pages marked [LIKELY CHAPTER 1 START] - verify if correct
- The chapter ends when Chapter 2 (or similar) begins

Return JSON only:
{{"chapter1_start_page": <number>, "chapter1_end_page": <number>, "chapter1_title": "<title>", "reasoning": "<why>"}}"""

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {openrouter_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "meta-llama/llama-3.1-8b-instruct:free",
                    "messages": [
                        {"role": "system", "content": "You find chapter boundaries in books. Output valid JSON only."},
                        {"role": "user", "content": prompt}
                    ],
                    "max_tokens": 150,
                    "temperature": 0.1
                },
                timeout=45.0
            )
            
            data = response.json()
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            print(f"LLM response: {content}")
            
            json_match = re.search(r'\{[^}]+\}', content, re.DOTALL)
            if json_match:
                result = json.loads(json_match.group())
                return {
                    "chapter1_start": result.get("chapter1_start_page"),
                    "chapter1_end": result.get("chapter1_end_page"),
                    "chapter1_title": result.get("chapter1_title", "Chapter 1"),
                    "reasoning": result.get("reasoning", "LLM detection")
                }
        except Exception as e:
            print(f"LLM error: {e}")
    
    return None


def extract_pages_to_pdf(pdf_content: bytes, start_page: int, end_page: int) -> bytes:
    """
    Extract a range of pages from a PDF and return as new PDF bytes.
    start_page and end_page are 1-indexed and inclusive.
    """
    reader = PdfReader(BytesIO(pdf_content))
    writer = PdfWriter()
    
    total_pages = len(reader.pages)
    
    # Validate page range
    start_idx = max(0, start_page - 1)
    end_idx = min(total_pages, end_page)
    
    print(f"Extracting pages {start_page} to {end_page} (indices {start_idx} to {end_idx-1})")
    
    for i in range(start_idx, end_idx):
        writer.add_page(reader.pages[i])
    
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def extract_text_from_pages(pdf_content: bytes, start_page: int, end_page: int) -> str:
    """
    Extract text from a range of pages.
    start_page and end_page are 1-indexed and inclusive.
    """
    reader = PdfReader(BytesIO(pdf_content))
    total_pages = len(reader.pages)
    
    start_idx = max(0, start_page - 1)
    end_idx = min(total_pages, end_page)
    
    text_parts = []
    for i in range(start_idx, end_idx):
        try:
            page_text = reader.pages[i].extract_text() or ""
            text_parts.append(f"--- Page {i + 1} ---\n{page_text}")
        except Exception as e:
            print(f"Error extracting text from page {i+1}: {e}")
    
    return "\n\n".join(text_parts)


async def extract_chapter_one(
    pdf_content: bytes,
    openrouter_api_key: str,
    book_title: str = "",
    max_chapter_pages: int = 30
) -> tuple[bytes, str, dict]:
    """
    Main function to extract Chapter 1 from a book PDF.
    
    Returns (chapter_pdf_bytes, chapter_text, info_dict)
    """
    reader = PdfReader(BytesIO(pdf_content))
    total_pages = len(reader.pages)
    
    print(f"\n{'='*50}")
    print(f"Extracting Chapter 1 from: {book_title or 'Unknown book'}")
    print(f"Total pages in book: {total_pages}")
    print(f"{'='*50}")
    
    # Step 1: Extract and analyze page snippets
    print("\nStep 1: Extracting and analyzing page snippets...")
    snippets = await extract_page_snippets(pdf_content, max_pages=60)
    print(f"Extracted snippets from {len(snippets)} pages")
    
    # Count front matter pages found
    front_matter_count = sum(1 for s in snippets if s["is_front_matter"])
    chapter_starts_found = [s["page"] for s in snippets if s["is_chapter_start"]]
    print(f"Found {front_matter_count} front matter pages")
    print(f"Potential chapter starts at pages: {chapter_starts_found}")
    
    # Step 2: Find chapter boundaries using heuristics first
    print("\nStep 2: Finding chapter boundaries with heuristics...")
    boundaries = find_chapter_boundaries_heuristic(snippets)
    
    # Step 3: Optionally verify with LLM if heuristic result seems uncertain
    if openrouter_api_key and boundaries["chapter1_start"] < 5:
        print("\nStep 3: Verifying with LLM (start page seems early)...")
        llm_result = await identify_chapter_boundaries_llm(snippets, openrouter_api_key, book_title)
        if llm_result and llm_result.get("chapter1_start"):
            # Use LLM result if it found a later start (more likely correct)
            if llm_result["chapter1_start"] > boundaries["chapter1_start"]:
                print(f"LLM suggests later start: page {llm_result['chapter1_start']}")
                boundaries = llm_result
    
    chapter1_start = boundaries["chapter1_start"]
    chapter1_end = boundaries["chapter1_end"]
    chapter1_title = boundaries["chapter1_title"]
    
    print(f"\nChapter 1 identified: pages {chapter1_start} to {chapter1_end}")
    print(f"Title: {chapter1_title}")
    print(f"Method: {boundaries.get('reasoning', 'N/A')}")
    
    # Limit chapter length
    if chapter1_end - chapter1_start + 1 > max_chapter_pages:
        original_end = chapter1_end
        chapter1_end = chapter1_start + max_chapter_pages - 1
        print(f"Chapter too long, limiting from {original_end} to {chapter1_end}")
    
    # Step 4: Extract the pages as PDF
    print("\nStep 4: Extracting chapter pages to new PDF...")
    chapter_pdf = extract_pages_to_pdf(pdf_content, chapter1_start, chapter1_end)
    
    # Step 5: Extract the text
    print("\nStep 5: Extracting chapter text...")
    chapter_text = extract_text_from_pages(pdf_content, chapter1_start, chapter1_end)
    
    extracted_pages = chapter1_end - chapter1_start + 1
    print(f"✓ Extracted {extracted_pages} pages")
    print(f"✓ Extracted {len(chapter_text)} characters of text")
    
    info = {
        "title": chapter1_title,
        "start_page": chapter1_start,
        "end_page": chapter1_end,
        "extracted_pages": extracted_pages,
        "total_book_pages": total_pages,
        "reasoning": boundaries.get("reasoning", ""),
        "size_bytes": len(chapter_pdf),
        "text_length": len(chapter_text)
    }
    
    return chapter_pdf, chapter_text, info


# For testing
if __name__ == "__main__":
    import asyncio
    import os
    from dotenv import load_dotenv
    
    load_dotenv()
    
    async def test():
        # Test with a sample PDF
        test_pdf = Path("downloads/test.pdf")
        if test_pdf.exists():
            with open(test_pdf, "rb") as f:
                pdf_content = f.read()
            
            chapter_pdf, info = await extract_chapter_one(
                pdf_content,
                os.getenv("OPENROUTER_API_KEY"),
                "Test Book"
            )
            
            # Save extracted chapter
            with open("downloads/test_chapter1.pdf", "wb") as f:
                f.write(chapter_pdf)
            
            print(f"\nResult: {info}")
    
    asyncio.run(test())

