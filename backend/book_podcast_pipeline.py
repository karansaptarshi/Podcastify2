"""
Generate full-book podcast audio from R2 text chunks.

This module expects `text_chunks.jsonl` from `text_chunker.py`. It processes the
first chunk with the first-chapter prompt, processes all later chunks with the
standard chunk prompt, renders each generated dialogue script to voice audio,
uploads each MP3 to R2, and yields queue items in playback order.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
from dataclasses import dataclass
from typing import AsyncIterator, Awaitable, Callable, Optional, Union
from uuid import uuid4

import httpx
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv

from r2_storage import get_bucket, get_r2_client
from text_chunker import TEXT_CHUNK_SIZE
from tts.make_audio import render_hook_async, upload_to_r2

load_dotenv()

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "moonshotai/kimi-k2.6"
WORDS_PER_FULL_CHUNK = 1_500


class BookPodcastPipelineError(Exception):
    """Raised when full-book podcast generation cannot continue."""


@dataclass
class TextChunk:
    index: int
    text: str
    char_count: int


@dataclass
class PodcastQueueItem:
    chunk_index: int
    audio_key: str
    audio_url: str
    script: str
    model: str
    target_words: int
    part_index: int = 1


QueueCallback = Callable[[PodcastQueueItem], Union[None, Awaitable[None]]]


def _openrouter_headers() -> dict[str, str]:
    api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        raise BookPodcastPipelineError("OPENROUTER_API_KEY is not configured")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Title": os.getenv("OPENROUTER_APP_NAME", "Podcastly"),
    }

    app_url = os.getenv("OPENROUTER_APP_URL", "").strip()
    if app_url:
        headers["HTTP-Referer"] = app_url

    return headers


def _audio_storage_key(
    book_title: str,
    chunk_index: int,
    part_index: Optional[int] = None,
) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", book_title.lower()).strip("-") or "book"
    if part_index is not None:
        return f"audio/{slug}/full-book/chunk-{chunk_index:03d}-part-{part_index:03d}-{uuid4().hex}.mp3"
    return f"audio/{slug}/full-book/chunk-{chunk_index:03d}-{uuid4().hex}.mp3"


def _target_words(char_count: int) -> int:
    if char_count <= 0:
        return 0
    scaled = round(WORDS_PER_FULL_CHUNK * (char_count / TEXT_CHUNK_SIZE))
    return max(250, scaled)


def _extract_dialogue(raw: str) -> str:
    lines: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if re.match(r"^(CHRIS|NAVAL)\s*:", stripped, re.IGNORECASE):
            speaker, _, text = stripped.partition(":")
            if text.strip():
                lines.append(f"{speaker.upper()}: {text.strip()}")

    if lines:
        return "\n".join(lines)

    match = re.search(r"(?m)^(CHRIS|NAVAL)\s*:", raw, re.IGNORECASE)
    if match:
        return _extract_dialogue(raw[match.start() :])

    return ""


def _normalize_dialogue_line(line: str) -> Optional[str]:
    stripped = line.strip()
    if not stripped:
        return None

    match = re.match(r"^(CHRIS|NAVAL)\s*:\s*(.+)$", stripped, re.IGNORECASE)
    if not match:
        return None

    speaker = match.group(1).upper()
    text = match.group(2).strip()
    if not text:
        return None

    return f"{speaker}: {text}"


def _load_text_chunks_from_r2(text_chunks_key: str) -> list[TextChunk]:
    try:
        response = get_r2_client().get_object(Bucket=get_bucket(), Key=text_chunks_key)
        body = response["Body"].read().decode("utf-8")
    except (BotoCoreError, ClientError, KeyError, UnicodeDecodeError) as exc:
        raise BookPodcastPipelineError(f"Could not read text chunks from R2: {exc}") from exc

    chunks: list[TextChunk] = []
    for line_number, line in enumerate(body.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            text = str(row["text"])
            index = int(row["index"])
            char_count = int(row.get("char_count", len(text)))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise BookPodcastPipelineError(
                f"Invalid text chunk JSONL on line {line_number}: {exc}"
            ) from exc

        chunks.append(TextChunk(index=index, text=text, char_count=char_count))

    if not chunks:
        raise BookPodcastPipelineError("R2 text chunk file is empty")

    return sorted(chunks, key=lambda chunk: chunk.index)


def _first_chunk_prompt(
    book_title: str,
    chunk: TextChunk,
    total_chunks: int,
    target_words: int,
) -> list[dict[str, str]]:
    return _messages(
        book_title=book_title,
        chunk=chunk,
        total_chunks=total_chunks,
        target_words=target_words,
        first_chunk=True,
    )


def _standard_chunk_prompt(
    book_title: str,
    chunk: TextChunk,
    total_chunks: int,
    target_words: int,
) -> list[dict[str, str]]:
    return _messages(
        book_title=book_title,
        chunk=chunk,
        total_chunks=total_chunks,
        target_words=target_words,
        first_chunk=False,
    )


def _messages(
    book_title: str,
    chunk: TextChunk,
    total_chunks: int,
    target_words: int,
    *,
    first_chunk: bool,
) -> list[dict[str, str]]:
    first_chunk_instruction = (
        "This is the first chunk, so it may contain front matter before the "
        "actual book begins, such as copyright pages, title pages, dedication, "
        "table of contents, praise, publisher information, acknowledgements, "
        "forewords, prefaces, or other introductory material. Ignore any "
        "material before the first real chapter or main body of the book begins, "
        "unless it contains essential context needed to understand the book. "
        "Start the podcast from the point where the actual book's ideas begin."
    )

    user_intro = (
        "You are writing the first segment of a high-quality conversational "
        "podcast based on a book."
        if first_chunk
        else "You are writing one segment of a high-quality conversational podcast based on a book."
    )

    return [
        {
            "role": "system",
            "content": (
                "You transform book text into a natural two-host podcast script. "
                "Output ONLY speaker-labelled dialogue. Every line must begin "
                "with CHRIS: or NAVAL:. CHRIS is the main explainer: he clearly "
                "walks the listener through the ideas, connects examples, adds "
                "structure, and makes the book easy to follow. NAVAL is the "
                "curious questioner: he asks sharp, thoughtful questions, "
                "challenges assumptions, requests examples, and occasionally "
                "reflects back the deeper implication. Do not invent unsupported "
                "facts, do not include markdown, and do not include titles, notes, "
                "summaries, or production directions."
            ),
        },
        {
            "role": "user",
            "content": (
                f"{user_intro}\n\n"
                f"Book: {book_title}\n"
                f"Chunk number: {chunk.index} of {total_chunks}\n\n"
                + (f"Important:\n{first_chunk_instruction}\n\n" if first_chunk else "")
                + f"Here is the current 50k-character book text chunk:\n{chunk.text}\n\n"
                "Turn this chunk into a compelling podcast segment between two hosts.\n\n"
                "Goals:\n"
                "- Preserve the author's core ideas, arguments, examples, and emotional tone.\n"
                "- Do not summarize too thinly. Make this feel like a real part of the book, not a recap.\n"
                "- Convert dense prose into natural spoken conversation.\n"
                "- Highlight surprising insights, useful takeaways, tensions, stories, and memorable lines.\n"
                "- If the chunk starts or ends mid-idea, handle it naturally without pretending the idea is complete.\n"
                "- Avoid inventing facts that are not supported by the text.\n"
                "- Avoid generic filler like \"this chunk is about\" unless it sounds natural.\n"
                "- Make it engaging for listeners who have not read the book.\n\n"
                "Host roles:\n"
                "- CHRIS is the main explainer. He clearly walks the listener through the ideas, connects examples, adds structure, and makes the book easy to follow.\n"
                "- NAVAL is the curious questioner. He asks sharp, thoughtful questions, challenges assumptions, requests examples, and occasionally reflects back the deeper implication.\n\n"
                "Format:\n"
                "CHRIS: ...\n"
                "NAVAL: ...\n\n"
                f"Target length:\nWrite approximately {target_words} words of dialogue for this chunk. "
                "Do not pad. Prioritize the most important ideas from this chunk while keeping the conversation natural and listenable."
            ),
        },
    ]


async def _generate_chunk_script(
    book_title: str,
    chunk: TextChunk,
    total_chunks: int,
) -> tuple[str, str, int]:
    model = os.getenv("OPENROUTER_MODEL", DEFAULT_MODEL)
    target_words = _target_words(chunk.char_count)
    messages = (
        _first_chunk_prompt(book_title, chunk, total_chunks, target_words)
        if chunk.index == 1
        else _standard_chunk_prompt(book_title, chunk, total_chunks, target_words)
    )

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.65,
        "max_tokens": max(2_500, round(target_words * 2.0)),
        "reasoning": {"effort": "none", "exclude": True},
    }

    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            response = await client.post(
                OPENROUTER_URL,
                headers=_openrouter_headers(),
                json=payload,
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500]
        raise BookPodcastPipelineError(
            f"OpenRouter rejected chunk {chunk.index}: {detail}"
        ) from exc
    except httpx.HTTPError as exc:
        raise BookPodcastPipelineError(f"Could not reach OpenRouter: {exc}") from exc

    data = response.json()
    content = data.get("choices", [{}])[0].get("message", {}).get("content")
    script = _extract_dialogue(content.strip() if isinstance(content, str) else "")
    if not script:
        raise BookPodcastPipelineError(
            f"OpenRouter returned no dialogue for chunk {chunk.index}"
        )

    return script, model, target_words


async def _stream_chunk_script_lines(
    book_title: str,
    chunk: TextChunk,
    total_chunks: int,
) -> AsyncIterator[tuple[str, str, int]]:
    model = os.getenv("OPENROUTER_MODEL", DEFAULT_MODEL)
    target_words = _target_words(chunk.char_count)
    messages = (
        _first_chunk_prompt(book_title, chunk, total_chunks, target_words)
        if chunk.index == 1
        else _standard_chunk_prompt(book_title, chunk, total_chunks, target_words)
    )

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.65,
        "max_tokens": max(2_500, round(target_words * 2.0)),
        "reasoning": {"effort": "none", "exclude": True},
        "stream": True,
    }

    buffer = ""
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            async with client.stream(
                "POST",
                OPENROUTER_URL,
                headers=_openrouter_headers(),
                json=payload,
            ) as response:
                response.raise_for_status()
                async for raw_line in response.aiter_lines():
                    line = raw_line.strip()
                    if not line or not line.startswith("data:"):
                        continue

                    data = line.removeprefix("data:").strip()
                    if data == "[DONE]":
                        break

                    try:
                        event = json.loads(data)
                    except json.JSONDecodeError:
                        continue

                    delta = (
                        event.get("choices", [{}])[0]
                        .get("delta", {})
                        .get("content")
                    )
                    if not isinstance(delta, str):
                        continue

                    buffer += delta
                    while "\n" in buffer:
                        next_line, buffer = buffer.split("\n", 1)
                        normalized = _normalize_dialogue_line(next_line)
                        if normalized:
                            yield normalized, model, target_words
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500]
        raise BookPodcastPipelineError(
            f"OpenRouter rejected chunk {chunk.index}: {detail}"
        ) from exc
    except httpx.HTTPError as exc:
        raise BookPodcastPipelineError(f"Could not reach OpenRouter: {exc}") from exc

    normalized = _normalize_dialogue_line(buffer)
    if normalized:
        yield normalized, model, target_words


async def _notify_queue(callback: QueueCallback | None, item: PodcastQueueItem) -> None:
    if not callback:
        return

    result = callback(item)
    if inspect.isawaitable(result):
        await result


async def iter_full_book_podcast_queue(
    *,
    book_title: str,
    text_chunks_key: str,
    on_queue_item: QueueCallback | None = None,
) -> AsyncIterator[PodcastQueueItem]:
    """
    Yield a queue item after each chunk script is generated, voiced, and uploaded.

    A caller can pass `on_queue_item` to push `item.audio_url` into the frontend
    or job queue immediately while later chunks continue generating.
    """
    chunks = await asyncio.to_thread(_load_text_chunks_from_r2, text_chunks_key)
    total_chunks = len(chunks)

    for chunk in chunks:
        item = await generate_book_chunk_queue_item(
            book_title=book_title,
            text_chunks_key=text_chunks_key,
            chunk_index=chunk.index,
            chunks=chunks,
        )
        await _notify_queue(on_queue_item, item)
        yield item


async def generate_full_book_podcast_queue(
    *,
    book_title: str,
    text_chunks_key: str,
    on_queue_item: QueueCallback | None = None,
) -> list[PodcastQueueItem]:
    """Run the full chunk-to-audio pipeline and return the completed queue."""
    queue: list[PodcastQueueItem] = []
    async for item in iter_full_book_podcast_queue(
        book_title=book_title,
        text_chunks_key=text_chunks_key,
        on_queue_item=on_queue_item,
    ):
        queue.append(item)
    return queue


async def generate_book_chunk_queue_item(
    *,
    book_title: str,
    text_chunks_key: str,
    chunk_index: int,
    chunks: Optional[list[TextChunk]] = None,
) -> PodcastQueueItem:
    """Generate, voice, upload, and return one chunk's queue item."""
    all_chunks = chunks or await asyncio.to_thread(_load_text_chunks_from_r2, text_chunks_key)
    chunk = next((item for item in all_chunks if item.index == chunk_index), None)
    if not chunk:
        raise BookPodcastPipelineError(f"Text chunk {chunk_index} was not found")

    script, model, target_words = await _generate_chunk_script(
        book_title,
        chunk,
        len(all_chunks),
    )
    audio = await render_hook_async(script)
    audio_key = _audio_storage_key(book_title, chunk.index)
    audio_url = await asyncio.to_thread(upload_to_r2, audio, audio_key)

    return PodcastQueueItem(
        chunk_index=chunk.index,
        audio_key=audio_key,
        audio_url=audio_url,
        script=script,
        model=model,
        target_words=target_words,
    )


async def stream_book_chunk_queue_items(
    *,
    book_title: str,
    text_chunks_key: str,
    chunk_index: int,
    line_batch_size: int = 4,
) -> AsyncIterator[PodcastQueueItem]:
    """Yield small voiced queue items as soon as 3-4 generated dialogue lines are ready."""
    all_chunks = await asyncio.to_thread(_load_text_chunks_from_r2, text_chunks_key)
    chunk = next((item for item in all_chunks if item.index == chunk_index), None)
    if not chunk:
        raise BookPodcastPipelineError(f"Text chunk {chunk_index} was not found")

    batch_size = max(1, min(line_batch_size, 8))
    batch: list[str] = []
    part_index = 1
    model = os.getenv("OPENROUTER_MODEL", DEFAULT_MODEL)
    target_words = _target_words(chunk.char_count)

    async for line, model, target_words in _stream_chunk_script_lines(
        book_title,
        chunk,
        len(all_chunks),
    ):
        batch.append(line)
        if len(batch) < batch_size:
            continue

        script = "\n".join(batch)
        audio = await render_hook_async(script)
        audio_key = _audio_storage_key(book_title, chunk.index, part_index)
        audio_url = await asyncio.to_thread(upload_to_r2, audio, audio_key)
        yield PodcastQueueItem(
            chunk_index=chunk.index,
            part_index=part_index,
            audio_key=audio_key,
            audio_url=audio_url,
            script=script,
            model=model,
            target_words=target_words,
        )
        batch = []
        part_index += 1

    if batch:
        script = "\n".join(batch)
        audio = await render_hook_async(script)
        audio_key = _audio_storage_key(book_title, chunk.index, part_index)
        audio_url = await asyncio.to_thread(upload_to_r2, audio, audio_key)
        yield PodcastQueueItem(
            chunk_index=chunk.index,
            part_index=part_index,
            audio_key=audio_key,
            audio_url=audio_url,
            script=script,
            model=model,
            target_words=target_words,
        )
