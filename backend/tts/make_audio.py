# requires `pip install httpx pydub boto3` and ffmpeg installed.
import os
from io import BytesIO

import boto3
import httpx
from dotenv import load_dotenv
from pydub import AudioSegment

load_dotenv()

XAI_API_KEY = os.getenv("XAI_API_KEY", "")
XAI_TTS_URL = "https://api.x.ai/v1/tts"
R2_ENDPOINT = os.getenv(
    "R2_ENDPOINT_URL",
    f"https://{os.getenv('R2_ACCOUNT_ID', '<ACCOUNT_ID>')}.r2.cloudflarestorage.com",
)
R2_ACCESS_KEY = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET = os.getenv("R2_BUCKET", "")
R2_PUBLIC_URL = os.getenv("R2_PUBLIC_BASE_URL", "https://pub-xxxx.r2.dev").rstrip("/")

VOICES = {"CHRIS": "96819d0bd28d", "NAVAL": "leo"}
OUTPUT_FORMAT = {"codec": "mp3", "sample_rate": 44100, "bit_rate": 128000}


class TextToSpeechError(Exception):
    """Raised when hook audio cannot be rendered by the TTS provider."""


def make_audio(text, voice) -> bytes:
    if not XAI_API_KEY:
        raise TextToSpeechError("XAI_API_KEY is not configured")

    payload = {
        "text": text,
        "voice_id": voice,
        "output_format": OUTPUT_FORMAT,
        "language": "en",
        "speed": 1.0,
    }
    headers = {
        "Authorization": f"Bearer {XAI_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        response = httpx.post(
            XAI_TTS_URL,
            headers=headers,
            json=payload,
            timeout=60.0,
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500]
        raise TextToSpeechError(f"xAI TTS rejected the request: {detail}") from exc
    except httpx.HTTPError as exc:
        raise TextToSpeechError(f"Could not reach xAI TTS: {exc}") from exc

    if not response.content:
        raise TextToSpeechError("xAI TTS returned empty audio")

    return response.content


def parse_speaker_line(line):
    if ":" not in line:
        return None, ""

    speaker, text = line.split(":", 1)
    return speaker.upper().strip(), text.strip()


def render_hook(script) -> bytes:
    combined = AudioSegment.empty()
    rendered_segments = 0

    for line in script.splitlines():
        speaker, text = parse_speaker_line(line)

        if speaker not in VOICES or not text:
            continue

        # Only send the dialogue text to xAI; the speaker label picks the voice.
        audio_bytes = make_audio(text, VOICES[speaker])
        segment = AudioSegment.from_file(BytesIO(audio_bytes), format="mp3")
        combined += segment
        rendered_segments += 1

    if rendered_segments == 0:
        raise TextToSpeechError("Hook has no CHRIS:/NAVAL: dialogue lines to render")

    output = BytesIO()
    combined.export(output, format="mp3")
    return output.getvalue()


def upload_to_r2(audio_bytes, key) -> str:
    client = boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
        region_name="auto",
    )
    client.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=audio_bytes,
        ContentType="audio/mpeg",
    )
    return f"{R2_PUBLIC_URL}/{key}"


if __name__ == "__main__":
    HOOK = """CHRIS: Naval, what's the trap most people miss when chasing success?
NAVAL: They copy outcomes instead of understanding principles.
CHRIS: So the shortcut is actually learning how to think?
NAVAL: Exactly. Better judgment compounds faster than effort alone."""

    audio = render_hook(HOOK)
    url = upload_to_r2(audio, "hook.mp3")
    print(url)
