"""
Build R2-ready chunk files from extracted book text.

The PDF finder stores the full text first. Once that object is available in R2,
the API also stores this JSONL file so later podcast generation can stream or
process bounded chunks instead of loading the whole book as one prompt.
"""
from __future__ import annotations

import json

TEXT_CHUNK_SIZE = 50_000


def text_chunks_storage_key(book_folder: str) -> str:
    return f"{book_folder.rstrip('/')}/text_chunks.jsonl"


def split_text_into_chunks(text: str, chunk_size: int = TEXT_CHUNK_SIZE) -> list[str]:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be greater than zero")
    return [text[start : start + chunk_size] for start in range(0, len(text), chunk_size)]


def build_text_chunks_jsonl(text: str, chunk_size: int = TEXT_CHUNK_SIZE) -> tuple[str, int]:
    chunks = split_text_into_chunks(text, chunk_size)
    lines = []
    cursor = 0

    for index, chunk in enumerate(chunks, start=1):
        start_char = cursor
        end_char = cursor + len(chunk)
        cursor = end_char
        lines.append(
            json.dumps(
                {
                    "index": index,
                    "start_char": start_char,
                    "end_char": end_char,
                    "char_count": len(chunk),
                    "text": chunk,
                },
                ensure_ascii=False,
            )
        )

    return "\n".join(lines), len(chunks)
