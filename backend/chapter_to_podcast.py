"""
Convert a book chapter to a podcast-style conversation using LLM
"""
import os
import re
import httpx
from pathlib import Path
from PyPDF2 import PdfReader
from dotenv import load_dotenv

load_dotenv()

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

# Output folder for scripts
SCRIPTS_DIR = Path(__file__).parent / "scripts"
SCRIPTS_DIR.mkdir(exist_ok=True)


def extract_text_from_pdf(pdf_path: str) -> str:
    """Extract all text from a PDF file"""
    reader = PdfReader(pdf_path)
    text = ""
    for page in reader.pages:
        page_text = page.extract_text()
        if page_text:
            text += page_text + "\n\n"
    return text.strip()


def clean_text(text: str) -> str:
    """Clean up extracted PDF text"""
    # Remove excessive whitespace
    text = re.sub(r'\n{3,}', '\n\n', text)
    # Remove page numbers
    text = re.sub(r'\n\s*\d+\s*\n', '\n', text)
    # Fix common OCR issues
    text = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', text)
    return text.strip()


async def generate_podcast_script(
    chapter_text: str,
    book_title: str,
    chapter_name: str = "Chapter 1",
    max_chunk_size: int = 12000
) -> str:
    """
    Generate a podcast conversation script from chapter text using LLM
    """
    if not OPENROUTER_API_KEY:
        raise ValueError("OPENROUTER_API_KEY not found in environment variables")
    
    # Truncate text if too long (LLM context limit)
    if len(chapter_text) > max_chunk_size:
        chapter_text = chapter_text[:max_chunk_size] + "\n\n[Content truncated for length...]"
    
    prompt = f"""You are a script writer for a popular podcast. Convert the following book chapter into an engaging podcast conversation between two hosts: Naval and Chris.

BOOK: {book_title}
CHAPTER: {chapter_name}

REQUIREMENTS:
1. Start with a brief introduction where both hosts introduce themselves
2. Mention the book title and chapter
3. Create a natural, engaging conversation discussing the key points from the chapter
4. Use name tags for each speaker like "Naval:" and "Chris:"
5. Naval should be more philosophical and ask deep questions
6. Chris should be more practical and give concrete examples
7. Include occasional banter and humor to keep it engaging
8. Cover the main themes, ideas, and any interesting passages from the chapter
9. End with a summary and teaser for next chapter
10. Make it feel like a real podcast conversation, not a lecture
11. Aim for about 10 minutes of speaking time (roughly 1500-2000 words)

CHAPTER CONTENT:
{chapter_text}

Generate the podcast script now. Start directly with the dialogue, no additional commentary:"""

    async with httpx.AsyncClient() as client:
        try:
            print("Generating podcast script with LLM...")
            
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "moonshotai/kimi-k2:free",
                    "messages": [
                        {
                            "role": "user",
                            "content": prompt
                        }
                    ],
                    "max_tokens": 4000,
                    "temperature": 0.8,
                },
                timeout=120.0  # Long timeout for generation
            )
            
            if response.status_code != 200:
                print(f"API Error: {response.status_code} - {response.text}")
                raise Exception(f"API returned status {response.status_code}")
            
            data = response.json()
            script = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            
            if not script:
                raise Exception("Empty response from LLM")
            
            print(f"Generated script with {len(script)} characters")
            return script
            
        except Exception as e:
            print(f"LLM generation error: {e}")
            raise


async def convert_chapter_to_podcast(
    chapter_pdf_path: str,
    book_title: str,
    chapter_name: str = "Chapter 1"
) -> dict:
    """
    Full pipeline: PDF -> Text -> Podcast Script
    Returns dict with script and metadata
    """
    # Extract text from PDF
    print(f"Extracting text from: {chapter_pdf_path}")
    raw_text = extract_text_from_pdf(chapter_pdf_path)
    clean_chapter_text = clean_text(raw_text)
    
    print(f"Extracted {len(clean_chapter_text)} characters of text")
    
    if len(clean_chapter_text) < 100:
        raise ValueError("Chapter text too short or extraction failed")
    
    # Generate podcast script
    script = await generate_podcast_script(
        chapter_text=clean_chapter_text,
        book_title=book_title,
        chapter_name=chapter_name
    )
    
    # Save script to file
    safe_title = re.sub(r'[^\w\s-]', '', book_title)[:50].strip()
    script_filename = f"{safe_title}_podcast_script.txt"
    script_path = SCRIPTS_DIR / script_filename
    
    with open(script_path, 'w', encoding='utf-8') as f:
        f.write(f"PODCAST SCRIPT: {book_title}\n")
        f.write(f"{'='*50}\n\n")
        f.write(script)
    
    print(f"Saved script to: {script_path}")
    
    # Count lines per speaker
    naval_lines = len(re.findall(r'^Naval:', script, re.MULTILINE))
    chris_lines = len(re.findall(r'^Chris:', script, re.MULTILINE))
    
    return {
        "script": script,
        "script_path": str(script_path),
        "script_filename": script_filename,
        "book_title": book_title,
        "chapter_name": chapter_name,
        "character_count": len(script),
        "naval_lines": naval_lines,
        "chris_lines": chris_lines,
        "source_text_length": len(clean_chapter_text)
    }


# For testing
if __name__ == "__main__":
    import asyncio
    
    async def test():
        # Test with a sample chapter
        chapters_dir = Path(__file__).parent / "chapters"
        pdfs = list(chapters_dir.glob("*.pdf"))
        
        if pdfs:
            result = await convert_chapter_to_podcast(
                chapter_pdf_path=str(pdfs[0]),
                book_title="Test Book",
                chapter_name="Chapter 1"
            )
            print("\n" + "="*50)
            print("GENERATED SCRIPT:")
            print("="*50)
            print(result["script"][:2000] + "...")
        else:
            print("No chapter PDFs found to test with")
    
    asyncio.run(test())

