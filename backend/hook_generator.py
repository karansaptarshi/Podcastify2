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
import re
from dataclasses import dataclass

import httpx
from dotenv import load_dotenv

load_dotenv()

_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
_DEFAULT_MODEL = "moonshotai/kimi-k2.6"
_DEFAULT_APP_NAME = "Podcastify"
_PLACEHOLDER_DIALOGUE = frozenset({"line of dialogue", "...", ""})


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


def _is_placeholder_line(line: str) -> bool:
    _, _, text = line.partition(":")
    return text.strip().lower() in _PLACEHOLDER_DIALOGUE


def _extract_hook_dialogue(raw: str) -> str:
    """Keep only CHRIS:/NAVAL: lines when the model adds extra text."""
    lines: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if re.match(r"^(CHRIS|NAVAL)\s*:", stripped, re.IGNORECASE):
            speaker, _, text = stripped.partition(":")
            lines.append(f"{speaker.upper()}: {text.strip()}")

    if lines:
        filtered = [line for line in lines if not _is_placeholder_line(line)]
        return "\n".join(filtered or lines)

    match = re.search(r"(?m)^(CHRIS|NAVAL)\s*:", raw, re.IGNORECASE)
    if match:
        return _extract_hook_dialogue(raw[match.start() :])

    return raw.strip()


def _hook_prompt(book_name: str) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": (
                "You write vivid, non-cliche podcast intros for a two-host "
                "book podcast with hosts Chris and Naval. Imagine the book itself "
                "has been transformed into a podcast conversation: capture its "
                "promise, mood, and central question rather than reporting facts "
                "about it. Tease, do not summarize. "
                "Naval should sound curious, skeptical, and question-led; Chris "
                "should do most of the answering, explaining, and framing. "
                "Do not make both hosts take turns summarizing the book. "
                "Output ONLY speaker-labelled dialogue. Never explain your process "
                "or describe the user's request. Every line must start with CHRIS: or NAVAL:."
            ),
        },
        {
            "role": "user",
            "content": (
                "You write a ~60-second intro for a two-host book "
                f"podcast Chris and Naval for the book {book_name}. "
                "Think as if you are turning the book into podcast form, and this "
                "is the intro that invites the listener into its world. Open with "
                "the feeling, problem, or question the listener is about to live "
                "inside, not a researched anecdote about the author, publication, "
                "sales, translations, historical reception, or specific scenes. "
                "Do not cite facts you cannot know from the title. Do not say "
                "\"the book starts with\" or make claims about what the author "
                "does on a specific page. Make it intimate, conversational, and "
                "non-cliche. Tease, don't summarize. End by naming the book and "
                "promising what's ahead. ~160 words. "
                "Shape the conversation so NAVAL mostly asks crisp, curious follow-up "
                "questions or challenges assumptions, while CHRIS gives the main "
                "answers and builds the tension. Avoid alternating two explanatory "
                "monologues about the book. "
                "Return only speaker-labelled dialogue lines, no markdown, in this exact format:\n"
                "CHRIS: line of dialogue\n"
                "NAVAL: line of dialogue"
            ),
        },
    ]


async def generate_book_hook(book_name: str) -> GeneratedHook:
    """Generate a short opening hook from a book name."""
    clean_book_name = book_name.strip() if isinstance(book_name, str) else ""
    if not clean_book_name:
        raise HookGenerationError("Book name is required")

    model = os.getenv("OPENROUTER_MODEL", _DEFAULT_MODEL)
    payload = {
        "model": model,
        "messages": _hook_prompt(clean_book_name),
        "temperature": 0.7,
        "max_tokens": 800,
        "reasoning": {"effort": "none", "exclude": True},
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
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
    content = (
        data.get("choices", [{}])[0]
        .get("message", {})
        .get("content")
    )
    raw_hook = content.strip() if isinstance(content, str) else ""
    hook = _extract_hook_dialogue(raw_hook)
    if not hook:
        raise HookGenerationError("OpenRouter returned an empty hook")
    if not re.search(r"^(CHRIS|NAVAL)\s*:", hook, re.MULTILINE | re.IGNORECASE):
        raise HookGenerationError("OpenRouter returned text without hook dialogue")

    return GeneratedHook(book_name=clean_book_name, hook=hook, model=model)


async def generate_book_hook_from_r2_key(r2_key: str) -> GeneratedHook:
    """Generate a hook using the readable book name inferred from an R2 key."""
    return await generate_book_hook(book_name_from_r2_key(r2_key))
