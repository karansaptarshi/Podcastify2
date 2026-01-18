from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx
from bs4 import BeautifulSoup
from dotenv import load_dotenv
import os
import re
import json
from pathlib import Path
from urllib.parse import quote_plus
from PyPDF2 import PdfReader
from io import BytesIO
from datetime import datetime

# Import smart chapter extraction
from extract_chapter import extract_chapter_one

load_dotenv()

app = FastAPI()

# Downloads folder for full book PDFs
DOWNLOADS_DIR = Path(__file__).parent / "downloads"
DOWNLOADS_DIR.mkdir(exist_ok=True)

# Chapters folder for extracted chapter PDFs
CHAPTERS_DIR = Path(__file__).parent / "chapters"
CHAPTERS_DIR.mkdir(exist_ok=True)

# Text folder for extracted chapter text
TEXT_DIR = Path(__file__).parent / "text"
TEXT_DIR.mkdir(exist_ok=True)

# Tracking file for downloaded books
TRACKING_FILE = Path(__file__).parent / "book_downloads.json"

# API Keys
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

# Allow CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_book_tracking() -> dict:
    """Load the book tracking data from JSON file"""
    if TRACKING_FILE.exists():
        try:
            with open(TRACKING_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except:
            return {"books": {}}
    return {"books": {}}


def save_book_tracking(data: dict):
    """Save the book tracking data to JSON file"""
    with open(TRACKING_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def get_book_key(title: str, author: str = "") -> str:
    """Generate a unique key for a book"""
    safe_title = re.sub(r'[^\w\s-]', '', title)[:50].strip().lower().replace(' ', '_')
    return safe_title


async def search_for_pdf(query: str) -> list[str]:
    """Search for PDF links using DuckDuckGo"""
    pdf_links = []
    
    async with httpx.AsyncClient() as client:
        try:
            search_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query + ' filetype:pdf')}"
            
            response = await client.get(
                search_url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
                },
                timeout=15.0,
                follow_redirects=True
            )
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            for link in soup.find_all('a', class_='result__url'):
                href = link.get('href', '')
                if href:
                    pdf_links.append(href)
            
            for link in soup.find_all('a', class_='result__a'):
                href = link.get('href', '')
                if '.pdf' in href.lower():
                    pdf_links.append(href)
                    
            for result in soup.find_all('a'):
                href = result.get('href', '')
                if 'pdf' in href.lower() and ('http' in href or 'www' in href):
                    if 'uddg=' in href:
                        import urllib.parse
                        parsed = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
                        if 'uddg' in parsed:
                            pdf_links.append(parsed['uddg'][0])
                    elif href.startswith('http'):
                        pdf_links.append(href)
            
            print(f"Found {len(pdf_links)} potential PDF links")
            
        except Exception as e:
            print(f"Search error: {e}")
    
    # Remove duplicates
    seen = set()
    unique_links = []
    for link in pdf_links:
        if link not in seen and link.startswith('http'):
            seen.add(link)
            unique_links.append(link)
    
    return unique_links[:10]


async def download_pdf(url: str) -> bytes | None:
    """Download a PDF and return its content"""
    async with httpx.AsyncClient() as client:
        try:
            print(f"Downloading: {url[:80]}...")
            
            response = await client.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
                },
                timeout=60.0,
                follow_redirects=True
            )
            
            content_type = response.headers.get('content-type', '')
            if 'pdf' not in content_type.lower() and not url.lower().endswith('.pdf'):
                print(f"Not a PDF: {content_type}")
                return None
            
            content = response.content
            if len(content) < 100000:  # 100KB minimum
                print(f"File too small: {len(content)} bytes")
                return None
            
            # Verify it's a valid PDF
            try:
                PdfReader(BytesIO(content))
                return content
            except:
                print("Invalid PDF format")
                return None
                
        except Exception as e:
            print(f"Download error: {e}")
            return None


@app.post("/api/find-pdf")
async def find_and_download_pdf(title: str, author: str = ""):
    """
    Find and download a PDF of the book.
    """
    print(f"\n{'='*50}")
    print(f"Processing: {title} by {author}")
    print(f"{'='*50}")
    
    # Create safe filename
    safe_title = re.sub(r'[^\w\s-]', '', title)[:50].strip()
    book_key = get_book_key(title, author)
    pdf_filename = f"{safe_title}.pdf"
    pdf_filepath = DOWNLOADS_DIR / pdf_filename
    
    # Load tracking data
    tracking = load_book_tracking()
    
    # Check if we already have this book
    if book_key in tracking["books"]:
        book_data = tracking["books"][book_key]
        if pdf_filepath.exists():
            print(f"Book already downloaded: {title}")
            reader = PdfReader(str(pdf_filepath))
            return {
                "status": "success",
                "message": "Book ready (cached)",
                "filename": pdf_filename,
                "filepath": str(pdf_filepath),
                "pages": len(reader.pages),
                "size_mb": round(pdf_filepath.stat().st_size / (1024 * 1024), 2),
                "cached": True
            }
    
    # Search for PDF
    search_query = f"{title} {author} book pdf"
    pdf_links = await search_for_pdf(search_query)
    
    if not pdf_links:
        pdf_links = await search_for_pdf(f"{title} pdf download free")
    
    if not pdf_links:
        raise HTTPException(status_code=404, detail="No PDF sources found for this book")
    
    # Try downloading from each link
    pdf_content = None
    source_url = None
    for url in pdf_links[:5]:
        pdf_content = await download_pdf(url)
        if pdf_content:
            source_url = url
            break
    
    if not pdf_content:
        raise HTTPException(
            status_code=404,
            detail="Could not download a valid PDF. The book may not be freely available."
        )
    
    # Get PDF info
    pdf_reader = PdfReader(BytesIO(pdf_content))
    total_pages = len(pdf_reader.pages)
    pdf_size_mb = round(len(pdf_content) / (1024 * 1024), 2)
    
    print(f"PDF has {total_pages} pages ({pdf_size_mb} MB)")
    
    # Save the PDF
    with open(pdf_filepath, 'wb') as f:
        f.write(pdf_content)
    print(f"✓ Book saved to: {pdf_filepath}")
    
    # Update tracking data
    tracking["books"][book_key] = {
        "title": title,
        "author": author,
        "filename": pdf_filename,
        "filepath": str(pdf_filepath),
        "size_mb": pdf_size_mb,
        "total_pages": total_pages,
        "source_url": source_url,
        "downloaded_at": datetime.now().isoformat(),
    }
    save_book_tracking(tracking)
    print(f"✓ Book tracked in: {TRACKING_FILE}")
    
    return {
        "status": "success",
        "message": f"Book downloaded ({total_pages} pages)",
        "filename": pdf_filename,
        "filepath": str(pdf_filepath),
        "pages": total_pages,
        "size_mb": pdf_size_mb,
        "cached": False
    }


@app.post("/api/extract-chapter")
async def extract_chapter(title: str, author: str = ""):
    """
    Extract Chapter 1 from a downloaded book using LLM-powered detection.
    Downloads both the chapter PDF and the chapter text.
    The book must be downloaded first using /api/find-pdf.
    """
    print(f"\n{'='*50}")
    print(f"Extracting Chapter 1 from: {title}")
    print(f"{'='*50}")
    
    # Find the full PDF
    safe_title = re.sub(r'[^\w\s-]', '', title)[:50].strip()
    book_key = get_book_key(title, author)
    pdf_filepath = DOWNLOADS_DIR / f"{safe_title}.pdf"
    chapter_filepath = CHAPTERS_DIR / f"{safe_title}_chapter1.pdf"
    text_filepath = TEXT_DIR / f"{safe_title}_chapter1.txt"
    
    # Check if chapter already extracted
    if chapter_filepath.exists() and text_filepath.exists():
        print(f"Chapter already extracted: {chapter_filepath}")
        reader = PdfReader(str(chapter_filepath))
        
        # Load tracking to get chapter info
        tracking = load_book_tracking()
        chapter_data = tracking.get("books", {}).get(book_key, {}).get("chapter1", {})
        
        return {
            "status": "success",
            "message": "Chapter 1 ready (cached)",
            "chapter_file": str(chapter_filepath),
            "text_file": str(text_filepath),
            "chapter_title": chapter_data.get("title", "Chapter 1"),
            "start_page": chapter_data.get("start_page"),
            "end_page": chapter_data.get("end_page"),
            "pages": len(reader.pages),
            "size_mb": round(chapter_filepath.stat().st_size / (1024 * 1024), 2),
            "cached": True
        }
    
    # Check if full book exists
    if not pdf_filepath.exists():
        raise HTTPException(
            status_code=404,
            detail="Book PDF not found. Please download the book first using /api/find-pdf"
        )
    
    # Read the full PDF
    with open(pdf_filepath, 'rb') as f:
        pdf_content = f.read()
    
    try:
        # Extract Chapter 1 using LLM-powered detection
        # Returns: (pdf_bytes, text, info_dict)
        chapter_pdf, chapter_text, chapter_info = await extract_chapter_one(
            pdf_content,
            OPENROUTER_API_KEY,
            book_title=title,
            max_chapter_pages=30
        )
        
        # Save the extracted chapter PDF
        with open(chapter_filepath, 'wb') as f:
            f.write(chapter_pdf)
        print(f"✓ Chapter PDF saved to: {chapter_filepath}")
        
        # Save the extracted chapter text
        with open(text_filepath, 'w', encoding='utf-8') as f:
            f.write(f"# {title}\n")
            f.write(f"## {chapter_info.get('title', 'Chapter 1')}\n")
            f.write(f"Pages {chapter_info.get('start_page')} - {chapter_info.get('end_page')}\n\n")
            f.write(chapter_text)
        print(f"✓ Chapter text saved to: {text_filepath}")
        
        # Update tracking
        tracking = load_book_tracking()
        if book_key in tracking["books"]:
            tracking["books"][book_key]["chapter1"] = {
                "pdf_filepath": str(chapter_filepath),
                "text_filepath": str(text_filepath),
                "title": chapter_info.get("title"),
                "start_page": chapter_info.get("start_page"),
                "end_page": chapter_info.get("end_page"),
                "pages": chapter_info.get("extracted_pages"),
                "text_length": len(chapter_text),
                "extracted_at": datetime.now().isoformat()
            }
            save_book_tracking(tracking)
        
        return {
            "status": "success",
            "message": f"Chapter 1 extracted ({chapter_info.get('extracted_pages')} pages)",
            "chapter_file": str(chapter_filepath),
            "text_file": str(text_filepath),
            "chapter_title": chapter_info.get("title"),
            "start_page": chapter_info.get("start_page"),
            "end_page": chapter_info.get("end_page"),
            "pages": chapter_info.get("extracted_pages"),
            "text_length": len(chapter_text),
            "size_mb": round(len(chapter_pdf) / (1024 * 1024), 2),
            "reasoning": chapter_info.get("reasoning"),
            "cached": False
        }
        
    except Exception as e:
        print(f"Chapter extraction error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Failed to extract chapter: {str(e)}"
        )


@app.get("/api/downloads")
async def list_downloads():
    """List all downloaded books"""
    tracking = load_book_tracking()
    
    downloads = []
    for book_key, book_data in tracking["books"].items():
        pdf_path = Path(book_data.get("filepath", ""))
        chapter_data = book_data.get("chapter1", {})
        
        downloads.append({
            "key": book_key,
            "title": book_data.get("title"),
            "author": book_data.get("author"),
            "filename": book_data.get("filename"),
            "exists": pdf_path.exists(),
            "pages": book_data.get("total_pages"),
            "size_mb": book_data.get("size_mb"),
            "downloaded_at": book_data.get("downloaded_at"),
            "chapter1": {
                "extracted": bool(chapter_data),
                "pages": chapter_data.get("pages"),
                "title": chapter_data.get("title")
            } if chapter_data else None
        })
    
    return {"downloads": downloads, "count": len(downloads)}


@app.post("/api/generate-script")
async def generate_podcast_script(title: str, author: str = ""):
    """
    Generate a podcast conversation script from Chapter 1 of a book.
    Will use extracted chapter if available, otherwise uses full book.
    """
    from chapter_to_podcast import convert_chapter_to_podcast
    
    print(f"\n{'='*50}")
    print(f"Generating podcast script for: {title}")
    print(f"{'='*50}")
    
    safe_title = re.sub(r'[^\w\s-]', '', title)[:50].strip()
    
    # Prefer extracted chapter, fall back to full book
    chapter_filepath = CHAPTERS_DIR / f"{safe_title}_chapter1.pdf"
    full_pdf_filepath = DOWNLOADS_DIR / f"{safe_title}.pdf"
    
    if chapter_filepath.exists():
        pdf_to_use = chapter_filepath
        chapter_name = "Chapter 1"
        print(f"Using extracted chapter: {chapter_filepath}")
    elif full_pdf_filepath.exists():
        pdf_to_use = full_pdf_filepath
        chapter_name = "Book"
        print(f"Using full book (no chapter extracted): {full_pdf_filepath}")
    else:
        raise HTTPException(
            status_code=404,
            detail="Book not found. Please download the book first."
        )
    
    try:
        result = await convert_chapter_to_podcast(
            chapter_pdf_path=str(pdf_to_use),
            book_title=title,
            chapter_name=chapter_name
        )
        
        return {
            "status": "success",
            "message": "Podcast script generated!",
            **result
        }
        
    except Exception as e:
        print(f"Script generation error: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate script: {str(e)}"
        )


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "openrouter_configured": bool(OPENROUTER_API_KEY)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
