from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.config import Settings
from backend.app.deepgram_service import DeepgramTranscriptionService
from backend.app.gemini_service import GeminiArtifactService
from backend.app.merge_engine import merge_chunk_results
from backend.app.models import ChunkTranscript, SpeakerSegment, TranscriptWord


def make_settings() -> Settings:
    return Settings(
        host="127.0.0.1",
        port=8000,
        cors_origins=("http://localhost:3000",),
        temp_root=Path(".backend_runtime"),
        database_url="",
        redis_url="",
        background_jobs_enabled=False,
        background_job_min_bytes=0,
        background_job_max_bytes=30 * 1024 * 1024,
        background_job_start_timeout_seconds=15,
        progress_retention_seconds=3600,
        progress_poll_interval_seconds=0.25,
        redis_max_connections=6,
        auth_session_hours=24,
        password_reset_token_minutes=30,
        admin_emails=(),
        auth_expose_reset_token=True,
        upload_chunk_size_bytes=1024,
        direct_transcribe_max_seconds=1200,
        gemini_auto_max_seconds=900,
        normalized_sample_rate=16000,
        normalized_channels=1,
        chunk_minutes=10,
        overlap_seconds=60,
        small_file_limit_bytes=10,
        medium_file_limit_bytes=20,
        small_worker_count=1,
        medium_worker_count=1,
        large_worker_count=1,
        upload_retry_count=0,
        transcription_retry_count=0,
        chunk_request_timeout_seconds=60,
        deepgram_api_key="test-key",
        deepgram_model="nova-3",
        deepgram_language="multi",
        deepgram_base_url="https://api.deepgram.com",
        deepgram_listen_path="/v1/listen",
        gemini_api_key="",
        gemini_model="gemini-2.5-flash",
        gemini_base_url="https://generativelanguage.googleapis.com/v1beta",
    )


class MultilingualTranscriptionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = make_settings()
        self.service = DeepgramTranscriptionService(self.settings)
        self.gemini = GeminiArtifactService(self.settings)

    def payload_for(self, transcript: str, words: list[dict], *, detected_language: str | None = None,
                    alternative_language: str | None = None, languages: list[str] | None = None) -> dict:
        channel: dict = {
            "alternatives": [
                {
                    "transcript": transcript,
                    "confidence": 0.98,
                    "words": words,
                }
            ]
        }
        if detected_language is not None:
            channel["detected_language"] = detected_language
        if languages is not None:
            channel["alternatives"][0]["languages"] = languages
        if alternative_language is not None:
            channel["alternatives"][0]["language"] = alternative_language
        return {"results": {"channels": [channel]}}

    def parse_case(self, transcript: str, words: list[dict], *, detected_language: str | None = None,
                   alternative_language: str | None = None, languages: list[str] | None = None) -> ChunkTranscript:
        return self.service._parse_payload(
            1,
            0.0,
            max((word.get("end", 0.0) for word in words), default=1.0),
            self.payload_for(
                transcript,
                words,
                detected_language=detected_language,
                alternative_language=alternative_language,
                languages=languages,
            ),
        )

    def assert_chunk_languages(self, chunk: ChunkTranscript, expected_primary: str, expected_languages: list[str]) -> None:
        self.assertEqual(chunk.language, expected_primary)
        self.assertEqual(chunk.languages, expected_languages)
        self.assertEqual([word.language for word in chunk.words if word.language], expected_languages if len(chunk.words) == len(expected_languages) else [word.language for word in chunk.words])

    def test_deepgram_request_defaults_to_nova3_multi(self) -> None:
        captured: dict = {}

        class Response:
            def raise_for_status(self) -> None:
                return None

            def json(self) -> dict:
                return {"results": {"channels": [{"alternatives": [{"transcript": "ok", "confidence": 1.0, "words": []}]}]}}

        class Client:
            def __init__(self, *args, **kwargs) -> None:
                pass

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def post(self, url, params=None, headers=None, content=None):
                captured["url"] = url
                captured["params"] = params
                captured["headers"] = headers
                captured["content_length"] = len(content or b"")
                return Response()

        import backend.app.deepgram_service as deepgram_module
        original_client = deepgram_module.httpx.Client
        deepgram_module.httpx.Client = Client
        try:
            sample_path = Path(__file__).resolve()
            self.service._transcribe_sync(sample_path)
        finally:
            deepgram_module.httpx.Client = original_client

        self.assertEqual(captured["params"]["model"], "nova-3")
        self.assertEqual(captured["params"]["language"], "multi")
        self.assertEqual(captured["params"]["diarize"], "true")
        self.assertEqual(captured["params"]["smart_format"], "true")
        self.assertEqual(captured["params"]["punctuate"], "true")

    def test_english_only_metadata(self) -> None:
        chunk = self.parse_case(
            "Hello, how are you today?",
            [
                {"word": "Hello", "punctuated_word": "Hello,", "start": 0.0, "end": 0.3, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "how", "start": 0.4, "end": 0.5, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "are", "start": 0.5, "end": 0.6, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "you", "start": 0.6, "end": 0.7, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "today", "punctuated_word": "today?", "start": 0.7, "end": 1.0, "confidence": 0.99, "speaker": 0, "language": "en"},
            ],
            detected_language="en",
            languages=["en"],
        )
        self.assertEqual(chunk.language, "en")
        self.assertEqual(chunk.languages, ["en"])
        self.assertEqual(chunk.speakers[0].languages, ["en"])

    def test_hindi_only_metadata(self) -> None:
        chunk = self.parse_case(
            "नमस्ते, आप कैसे हैं?",
            [
                {"word": "नमस्ते", "punctuated_word": "नमस्ते,", "start": 0.0, "end": 0.4, "confidence": 0.99, "speaker": 0, "language": "hi"},
                {"word": "आप", "start": 0.5, "end": 0.7, "confidence": 0.99, "speaker": 0, "language": "hi"},
                {"word": "कैसे", "start": 0.7, "end": 0.9, "confidence": 0.99, "speaker": 0, "language": "hi"},
                {"word": "हैं", "punctuated_word": "हैं?", "start": 0.9, "end": 1.1, "confidence": 0.99, "speaker": 0, "language": "hi"},
            ],
            detected_language="hi",
            languages=["hi"],
        )
        self.assertEqual(chunk.language, "hi")
        self.assertEqual(chunk.languages, ["hi"])

    def test_tamil_only_metadata(self) -> None:
        chunk = self.parse_case(
            "வணக்கம், நீங்கள் எப்படி இருக்கிறீர்கள்?",
            [
                {"word": "வணக்கம்", "punctuated_word": "வணக்கம்,", "start": 0.0, "end": 0.3, "confidence": 0.99, "speaker": 0, "language": "ta"},
                {"word": "நீங்கள்", "start": 0.4, "end": 0.7, "confidence": 0.99, "speaker": 0, "language": "ta"},
                {"word": "எப்படி", "start": 0.7, "end": 0.9, "confidence": 0.99, "speaker": 0, "language": "ta"},
                {"word": "இருக்கிறீர்கள்", "punctuated_word": "இருக்கிறீர்கள்?", "start": 0.9, "end": 1.3, "confidence": 0.99, "speaker": 0, "language": "ta"},
            ],
            alternative_language="ta",
            languages=["ta"],
        )
        self.assertEqual(chunk.language, "ta")
        self.assertEqual(chunk.languages, ["ta"])

    def test_telugu_only_metadata(self) -> None:
        chunk = self.parse_case(
            "హలో, మీరు ఎలా ఉన్నారు?",
            [
                {"word": "హలో", "punctuated_word": "హలో,", "start": 0.0, "end": 0.2, "confidence": 0.99, "speaker": 0, "language": "te"},
                {"word": "మీరు", "start": 0.3, "end": 0.6, "confidence": 0.99, "speaker": 0, "language": "te"},
                {"word": "ఎలా", "start": 0.6, "end": 0.8, "confidence": 0.99, "speaker": 0, "language": "te"},
                {"word": "ఉన్నారు", "punctuated_word": "ఉన్నారు?", "start": 0.8, "end": 1.1, "confidence": 0.99, "speaker": 0, "language": "te"},
            ],
            alternative_language="te",
            languages=["te"],
        )
        self.assertEqual(chunk.languages, ["te"])

    def test_malayalam_only_metadata(self) -> None:
        chunk = self.parse_case(
            "ഹലോ, സുഖമാണോ?",
            [
                {"word": "ഹലോ", "punctuated_word": "ഹലോ,", "start": 0.0, "end": 0.2, "confidence": 0.99, "speaker": 0, "language": "ml"},
                {"word": "സുഖമാണോ", "punctuated_word": "സുഖമാണോ?", "start": 0.3, "end": 0.7, "confidence": 0.99, "speaker": 0, "language": "ml"},
            ],
            alternative_language="ml",
            languages=["ml"],
        )
        self.assertEqual(chunk.languages, ["ml"])

    def test_kannada_only_metadata(self) -> None:
        chunk = self.parse_case(
            "ನಮಸ್ಕಾರ, ನೀವು ಹೇಗಿದ್ದೀರಿ?",
            [
                {"word": "ನಮಸ್ಕಾರ", "punctuated_word": "ನಮಸ್ಕಾರ,", "start": 0.0, "end": 0.3, "confidence": 0.99, "speaker": 0, "language": "kn"},
                {"word": "ನೀವು", "start": 0.3, "end": 0.5, "confidence": 0.99, "speaker": 0, "language": "kn"},
                {"word": "ಹೇಗಿದ್ದೀರಿ", "punctuated_word": "ಹೇಗಿದ್ದೀರಿ?", "start": 0.5, "end": 1.0, "confidence": 0.99, "speaker": 0, "language": "kn"},
            ],
            alternative_language="kn",
            languages=["kn"],
        )
        self.assertEqual(chunk.languages, ["kn"])

    def test_marathi_only_metadata(self) -> None:
        chunk = self.parse_case(
            "नमस्कार, तुम्ही कसे आहात?",
            [
                {"word": "नमस्कार", "punctuated_word": "नमस्कार,", "start": 0.0, "end": 0.3, "confidence": 0.99, "speaker": 0, "language": "mr"},
                {"word": "तुम्ही", "start": 0.3, "end": 0.5, "confidence": 0.99, "speaker": 0, "language": "mr"},
                {"word": "कसे", "start": 0.5, "end": 0.7, "confidence": 0.99, "speaker": 0, "language": "mr"},
                {"word": "आहात", "punctuated_word": "आहात?", "start": 0.7, "end": 1.0, "confidence": 0.99, "speaker": 0, "language": "mr"},
            ],
            alternative_language="mr",
            languages=["mr"],
        )
        self.assertEqual(chunk.languages, ["mr"])

    def test_english_hindi_code_switch_metadata(self) -> None:
        chunk = self.parse_case(
            "I worked at Infosys and फिर I joined another company.",
            [
                {"word": "I", "start": 0.0, "end": 0.1, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "worked", "start": 0.1, "end": 0.3, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "at", "start": 0.3, "end": 0.4, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "Infosys", "start": 0.4, "end": 0.7, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "and", "start": 0.7, "end": 0.8, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "फिर", "start": 0.8, "end": 1.0, "confidence": 0.99, "speaker": 0, "language": "hi"},
                {"word": "I", "start": 1.0, "end": 1.1, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "joined", "start": 1.1, "end": 1.4, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "another", "start": 1.4, "end": 1.7, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "company", "punctuated_word": "company.", "start": 1.7, "end": 2.0, "confidence": 0.99, "speaker": 0, "language": "en"},
            ],
            languages=["en", "hi"],
        )
        self.assertEqual(chunk.languages, ["en", "hi"])
        self.assertIn("hi", [word.language for word in chunk.words])
        self.assertEqual(chunk.speakers[0].languages, ["en", "hi"])

    def test_english_tamil_code_switch_metadata(self) -> None:
        chunk = self.parse_case(
            "I worked in Chennai and பின்னர் I moved to Bangalore.",
            [
                {"word": "I", "start": 0.0, "end": 0.1, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "worked", "start": 0.1, "end": 0.3, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "in", "start": 0.3, "end": 0.4, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "Chennai", "start": 0.4, "end": 0.7, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "and", "start": 0.7, "end": 0.8, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "பின்னர்", "start": 0.8, "end": 1.2, "confidence": 0.99, "speaker": 0, "language": "ta"},
                {"word": "I", "start": 1.2, "end": 1.3, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "moved", "start": 1.3, "end": 1.5, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "to", "start": 1.5, "end": 1.6, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "Bangalore", "punctuated_word": "Bangalore.", "start": 1.6, "end": 2.0, "confidence": 0.99, "speaker": 0, "language": "en"},
            ],
            languages=["en", "ta"],
        )
        self.assertEqual(chunk.languages, ["en", "ta"])

    def test_english_telugu_code_switch_metadata(self) -> None:
        chunk = self.parse_case(
            "I worked in Hyderabad and తర్వాత I joined a startup.",
            [
                {"word": "I", "start": 0.0, "end": 0.1, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "worked", "start": 0.1, "end": 0.3, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "in", "start": 0.3, "end": 0.4, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "Hyderabad", "start": 0.4, "end": 0.7, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "and", "start": 0.7, "end": 0.8, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "తర్వాత", "start": 0.8, "end": 1.1, "confidence": 0.99, "speaker": 0, "language": "te"},
                {"word": "I", "start": 1.1, "end": 1.2, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "joined", "start": 1.2, "end": 1.5, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "a", "start": 1.5, "end": 1.6, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "startup", "punctuated_word": "startup.", "start": 1.6, "end": 1.9, "confidence": 0.99, "speaker": 0, "language": "en"},
            ],
            languages=["en", "te"],
        )
        self.assertEqual(chunk.languages, ["en", "te"])

    def test_english_malayalam_code_switch_metadata(self) -> None:
        chunk = self.parse_case(
            "I worked remotely and പിന്നീട് I moved to Kochi.",
            [
                {"word": "I", "start": 0.0, "end": 0.1, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "worked", "start": 0.1, "end": 0.3, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "remotely", "start": 0.3, "end": 0.6, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "and", "start": 0.6, "end": 0.7, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "പിന്നീട്", "start": 0.7, "end": 1.0, "confidence": 0.99, "speaker": 0, "language": "ml"},
                {"word": "I", "start": 1.0, "end": 1.1, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "moved", "start": 1.1, "end": 1.3, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "to", "start": 1.3, "end": 1.4, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "Kochi", "punctuated_word": "Kochi.", "start": 1.4, "end": 1.7, "confidence": 0.99, "speaker": 0, "language": "en"},
            ],
            languages=["en", "ml"],
        )
        self.assertEqual(chunk.languages, ["en", "ml"])

    def test_english_kannada_code_switch_metadata(self) -> None:
        chunk = self.parse_case(
            "I worked in Bengaluru and ನಂತರ I joined another team.",
            [
                {"word": "I", "start": 0.0, "end": 0.1, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "worked", "start": 0.1, "end": 0.3, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "in", "start": 0.3, "end": 0.4, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "Bengaluru", "start": 0.4, "end": 0.7, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "and", "start": 0.7, "end": 0.8, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "ನಂತರ", "start": 0.8, "end": 1.0, "confidence": 0.99, "speaker": 0, "language": "kn"},
                {"word": "I", "start": 1.0, "end": 1.1, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "joined", "start": 1.1, "end": 1.3, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "another", "start": 1.3, "end": 1.6, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "team", "punctuated_word": "team.", "start": 1.6, "end": 1.8, "confidence": 0.99, "speaker": 0, "language": "en"},
            ],
            languages=["en", "kn"],
        )
        self.assertEqual(chunk.languages, ["en", "kn"])

    def test_triple_language_switching_metadata(self) -> None:
        chunk = self.parse_case(
            "I worked in Chennai, பின்னர் I moved to Hyderabad and అక్కడ I joined another company.",
            [
                {"word": "I", "start": 0.0, "end": 0.1, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "worked", "start": 0.1, "end": 0.3, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "in", "start": 0.3, "end": 0.4, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "Chennai", "punctuated_word": "Chennai,", "start": 0.4, "end": 0.7, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "பின்னர்", "start": 0.7, "end": 1.0, "confidence": 0.99, "speaker": 0, "language": "ta"},
                {"word": "I", "start": 1.0, "end": 1.1, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "moved", "start": 1.1, "end": 1.4, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "to", "start": 1.4, "end": 1.5, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "Hyderabad", "start": 1.5, "end": 1.8, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "and", "start": 1.8, "end": 1.9, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "అక్కడ", "start": 1.9, "end": 2.2, "confidence": 0.99, "speaker": 0, "language": "te"},
                {"word": "I", "start": 2.2, "end": 2.3, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "joined", "start": 2.3, "end": 2.5, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "another", "start": 2.5, "end": 2.8, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "company", "punctuated_word": "company.", "start": 2.8, "end": 3.1, "confidence": 0.99, "speaker": 0, "language": "en"},
            ],
            languages=["en", "ta", "te"],
        )
        self.assertEqual(chunk.languages, ["en", "ta", "te"])
        self.assertEqual(chunk.speakers[0].languages, ["en", "ta", "te"])

    def test_merge_preserves_multilingual_metadata(self) -> None:
        first = ChunkTranscript(
            chunk_id=1,
            start_time=0.0,
            end_time=2.0,
            transcript="Speaker 1: I worked at Infosys and फिर",
            language="en",
            detected_language="en",
            languages=["en", "hi"],
            confidence=0.98,
            words=[
                TranscriptWord(word="I", start_time=0.0, end_time=0.1, language="en"),
                TranscriptWord(word="worked", start_time=0.1, end_time=0.3, language="en"),
                TranscriptWord(word="फिर", start_time=0.8, end_time=1.0, language="hi"),
            ],
            speakers=[
                SpeakerSegment(
                    speaker="Speaker 1",
                    text="I worked at Infosys and फिर",
                    start_time=0.0,
                    end_time=2.0,
                    language="en",
                    languages=["en", "hi"],
                    words=[
                        TranscriptWord(word="I", start_time=0.0, end_time=0.1, language="en"),
                        TranscriptWord(word="worked", start_time=0.1, end_time=0.3, language="en"),
                        TranscriptWord(word="फिर", start_time=0.8, end_time=1.0, language="hi"),
                    ],
                )
            ],
        )
        second = ChunkTranscript(
            chunk_id=2,
            start_time=1.9,
            end_time=3.4,
            transcript="Speaker 1: फिर I joined another company.",
            language="hi",
            detected_language="hi",
            languages=["hi", "en"],
            confidence=0.97,
            words=[
                TranscriptWord(word="फिर", start_time=1.9, end_time=2.1, language="hi"),
                TranscriptWord(word="I", start_time=2.1, end_time=2.2, language="en"),
                TranscriptWord(word="joined", start_time=2.2, end_time=2.5, language="en"),
            ],
            speakers=[
                SpeakerSegment(
                    speaker="Speaker 1",
                    text="फिर I joined another company.",
                    start_time=1.9,
                    end_time=3.4,
                    language="hi",
                    languages=["hi", "en"],
                    words=[
                        TranscriptWord(word="फिर", start_time=1.9, end_time=2.1, language="hi"),
                        TranscriptWord(word="I", start_time=2.1, end_time=2.2, language="en"),
                        TranscriptWord(word="joined", start_time=2.2, end_time=2.5, language="en"),
                    ],
                )
            ],
        )

        merged = merge_chunk_results([first, second])
        self.assertEqual(merged.languages, ["en", "hi"])
        self.assertEqual(merged.speakers[0].languages, ["en", "hi"])
        self.assertIn("hi", [word.language for word in merged.speakers[0].words])

    def test_default_result_exposes_language_metadata(self) -> None:
        chunk = self.parse_case(
            "I worked at Infosys and फिर I joined another company.",
            [
                {"word": "I", "start": 0.0, "end": 0.1, "confidence": 0.99, "speaker": 0, "language": "en"},
                {"word": "फिर", "start": 0.8, "end": 1.0, "confidence": 0.99, "speaker": 0, "language": "hi"},
            ],
            languages=["en", "hi"],
        )
        merged = merge_chunk_results([chunk])
        result = self.gemini.build_default_result(merged)
        self.assertEqual(result.detected_language, "en")
        self.assertEqual(result.languages, ["en", "hi"])
        self.assertEqual(result.turns[0].languages, ["en", "hi"])
        self.assertEqual(result.turns[0].words[1].language, "hi")


if __name__ == "__main__":
    unittest.main()
