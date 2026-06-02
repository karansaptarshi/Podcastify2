"""
Generate the opening hook for a book podcast.

This module is intentionally small: it only creates the first quick cold open
from the book name, before the deeper reading/chunking pipeline runs.

Required environment variable:
    OPENROUTER_API_KEY

Optional environment variables:
    OPENROUTER_MODEL
    OPENROUTER_APP_URL
    OPENROUTER_APP_NAME
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import httpx
from dotenv import load_dotenv

load_dotenv()

_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
_DEFAULT_MODEL = "moonshotai/kimi-k2.6:free"
_DEFAULT_APP_NAME = "Podcastify"


class HookGenerationError(Exception):
    """Raised when the AI hook could not be generated."""


@dataclass
class GeneratedHook:
    book_name: str
    hook: str
    model: str


def book_name_from_r2_key(r2_key: str) -> str:
    """
    Infer a readable book name from keys like
    `books/the_almanack_by_naval_ravikant/text.txt`.

    The frontend can still pass the real title when it has it; this helper is
    for the generation pipeline when all it has is the stored R2 object key.
    """
    parts = [part for part in r2_key.strip("/").split("/") if part]
    raw_name = parts[1] if len(parts) >= 2 and parts[0] == "books" else r2_key.rsplit("/", maxsplit=1)[-1]
    readable_name = raw_name.replace("_", " ").replace("-", " ").title()
    return readable_name.replace(" By ", " by ")


def _openrouter_headers() -> dict[str, str]:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise HookGenerationError("OPENROUTER_API_KEY is not configured")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Title": os.getenv("OPENROUTER_APP_NAME", _DEFAULT_APP_NAME),
    }

    app_url = os.getenv("OPENROUTER_APP_URL")
    if app_url:
        headers["HTTP-Referer"] = app_url

    return headers


def _hook_prompt(book_name: str) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": (
                "You write vivid, non-cliche podcast cold opens for a two-host "
                "book podcast with hosts Chris and Naval. Tease, do not summarize."
            ),
        },
        {
            "role": "user",
            "content": (
                "You write a ~60-second cold-open hook for a two-host book "
                f"podcast Chris and Naval for the book {book_name}. "
                "Open with a vivid real life scenario, a sharp question, or a surprising "
                "claim that dramatizes the book's central tension. Make it "
                "non-cliche. Tease, don't summarize. End by naming the book and "
                "promising what's ahead. You may invent a framing scenario, but "
                "do NOT invent facts about the book's actual content. ~200 words. "
                "Return only the spoken hook, no labels and no markdown."
            ),
        },
    ]


async def generate_book_hook(book_name: str) -> GeneratedHook:
    """Generate a short opening hook from a book name."""
    clean_book_name = book_name.strip()
    if not clean_book_name:
        raise HookGenerationError("Book name is required")

    model = os.getenv("OPENROUTER_MODEL", _DEFAULT_MODEL)
    payload = {
        "model": model,
        "messages": _hook_prompt(clean_book_name),
        "temperature": 0.9,
        "max_tokens": 220,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                _OPENROUTER_URL,
                headers=_openrouter_headers(),
                json=payload,
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500]
        raise HookGenerationError(f"OpenRouter rejected the request: {detail}") from exc
    except httpx.HTTPError as exc:
        raise HookGenerationError(f"Could not reach OpenRouter: {exc}") from exc

    data = response.json()
    hook = (
        data.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
        .strip()
    )
    if not hook:
        raise HookGenerationError("OpenRouter returned an empty hook")

    return GeneratedHook(book_name=clean_book_name, hook=hook, model=model)


async def generate_book_hook_from_r2_key(r2_key: str) -> GeneratedHook:
    """Generate a hook using the readable book name inferred from an R2 key."""
    return await generate_book_hook(book_name_from_r2_key(r2_key))
