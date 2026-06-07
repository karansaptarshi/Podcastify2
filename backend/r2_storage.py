"""
Cloudflare R2 storage helper (S3-compatible).

Uploads downloaded book PDFs and extracted text to a Cloudflare R2 bucket.

Required environment variables:
    R2_ACCESS_KEY_ID       - R2 access key id (from R2 -> Manage API Tokens)
    R2_SECRET_ACCESS_KEY   - R2 secret access key

Optional environment variables (sensible defaults are provided):
    R2_ACCOUNT_ID          - Cloudflare account id (defaults to the project's account)
    R2_ENDPOINT_URL        - full S3 endpoint, e.g. https://<account>.r2.cloudflarestorage.com
    R2_BUCKET              - bucket name (default: podcastly)
    R2_PUBLIC_BASE_URL     - public URL base if the bucket is served via a public/custom domain
"""
import asyncio
import os

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv

# Load .env here too, so credentials are available regardless of whether the
# importing module has called load_dotenv() yet.
load_dotenv()

_client = None


def _account_id() -> str:
    # Account id is taken from the R2 endpoint the project uses:
    # https://b4a13a12455c62cdec8eae9367c6704a.r2.cloudflarestorage.com/podcastly
    return os.getenv("R2_ACCOUNT_ID", "b4a13a12455c62cdec8eae9367c6704a")


def get_endpoint_url() -> str:
    return os.getenv(
        "R2_ENDPOINT_URL", f"https://{_account_id()}.r2.cloudflarestorage.com"
    )


def get_bucket() -> str:
    return os.getenv("R2_BUCKET", "podcastly")


# Backwards-compatible module-level constants (read lazily via functions above
# for credentials; these reflect config at import time and are safe to display).
R2_ENDPOINT_URL = get_endpoint_url()
R2_BUCKET = get_bucket()


def r2_configured() -> bool:
    """Return True only when credentials are available to talk to R2."""
    return bool(os.getenv("R2_ACCESS_KEY_ID") and os.getenv("R2_SECRET_ACCESS_KEY"))


def get_r2_client():
    """Lazily create a cached boto3 S3 client pointed at the R2 endpoint."""
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=get_endpoint_url(),
            aws_access_key_id=os.getenv("R2_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY"),
            region_name="auto",
            config=Config(signature_version="s3v4"),
        )
    return _client


def _object_url(key: str) -> str:
    public_base = os.getenv("R2_PUBLIC_BASE_URL")
    if public_base:
        return f"{public_base.rstrip('/')}/{key}"
    return f"{get_endpoint_url()}/{get_bucket()}/{key}"


def _put_object(content: bytes, key: str, content_type: str) -> dict:
    client = get_r2_client()
    bucket = get_bucket()
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=content,
        ContentType=content_type,
    )
    return {
        "bucket": bucket,
        "key": key,
        "url": _object_url(key),
        "size_bytes": len(content),
    }


async def upload_bytes_to_r2(content: bytes, key: str, content_type: str) -> dict:
    """
    Upload bytes to R2 under the given key.

    Runs the blocking boto3 call in a worker thread so it never stalls the
    FastAPI event loop. Returns metadata about the uploaded object, or a dict
    with ``"uploaded": False`` when R2 is not configured / the upload fails.
    """
    if not r2_configured():
        return {
            "uploaded": False,
            "reason": "R2 not configured (set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY)",
        }

    try:
        result = await asyncio.to_thread(_put_object, content, key, content_type)
        result["uploaded"] = True
        return result
    except (BotoCoreError, ClientError, Exception) as e:  # noqa: BLE001
        return {"uploaded": False, "reason": str(e)}


async def upload_pdf_to_r2(
    content: bytes, key: str, content_type: str = "application/pdf"
) -> dict:
    """Upload PDF bytes to R2 under the given key."""
    return await upload_bytes_to_r2(content, key, content_type)


async def upload_text_to_r2(text: str, key: str) -> dict:
    """Upload extracted book text to R2 as UTF-8 plain text."""
    return await upload_bytes_to_r2(
        text.encode("utf-8"),
        key,
        "text/plain; charset=utf-8",
    )


async def upload_jsonl_text_to_r2(text: str, key: str) -> dict:
    """Upload a JSONL text object to R2 as UTF-8."""
    return await upload_bytes_to_r2(
        text.encode("utf-8"),
        key,
        "application/x-ndjson; charset=utf-8",
    )
