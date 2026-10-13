"""Settings + codebook loading."""
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parents[1]  # project root (next to main.py)
load_dotenv(BASE_DIR / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_BASE_URL = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
GEMINI_TIMEOUT_SECONDS = float(os.getenv("GEMINI_TIMEOUT_SECONDS", "120"))

# Cost printing. gemini-2.5-flash list price, USD per 1 million tokens
# (output price also covers the model's "thinking" tokens).
GEMINI_INPUT_PRICE_PER_M = float(os.getenv("GEMINI_INPUT_PRICE_PER_M", "0.30"))
GEMINI_OUTPUT_PRICE_PER_M = float(os.getenv("GEMINI_OUTPUT_PRICE_PER_M", "2.50"))
# Approximate exchange rate - change it in .env (USD_TO_INR=...) to the current rate.
USD_TO_INR = float(os.getenv("USD_TO_INR", "96.5"))
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")]

CODEBOOK_PATH = BASE_DIR / "codebook.json"

# Interview-content characters per Gemini request (not the codebook size).
BATCH_CHAR_LIMIT = 5000
# Max Gemini requests running at the same time.
MAX_CONCURRENT_GEMINI_BATCHES = 4


def _load_codebook() -> list[dict]:
    with open(CODEBOOK_PATH, "r", encoding="utf-8") as f:
        return json.load(f)["codes"]


CODEBOOK = _load_codebook()

CODEBOOK_TEXT = "\n\n".join(
    f"Principal Code: {c['principal_code']}\n"
    f"Sub-code: {c['sub_code']}\n"
    f"Explanation: {c.get('explanation', '')}"
    for c in CODEBOOK
)

# Valid (principal, sub) pairs - used to reject invented codes.
ALLOWED_CODES = {(c["principal_code"].strip(), c["sub_code"].strip()) for c in CODEBOOK}

# principal_code -> hex color without '#', e.g. "0A8DAF" (taken from the codebook PDF).
PRINCIPAL_COLORS = {
    c["principal_code"].strip(): c["color"].lstrip("#").upper()
    for c in CODEBOOK
    if c.get("color")
}