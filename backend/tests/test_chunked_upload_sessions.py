from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.main import UploadSessionStore, _assemble_chunked_upload


class UploadSessionStoreTests(unittest.TestCase):
    def test_create_update_and_pop_session(self) -> None:
        store = UploadSessionStore()
        with tempfile.TemporaryDirectory(prefix="viveka_test_") as temp_dir:
            session = store.create(Path(temp_dir), "sample.wav", 12345)
            self.assertEqual(session.received_bytes, 0)
            self.assertTrue(session.workspace.exists())
            self.assertEqual(store.get(session.upload_id).file_size_bytes, 12345)

            store.record_chunk(session.upload_id, 1, 3, 4096)
            self.assertEqual(store.get(session.upload_id).received_bytes, 4096)
            self.assertFalse(store.is_complete(session.upload_id))

            popped = store.pop(session.upload_id)
            self.assertEqual(popped.upload_id, session.upload_id)
            self.assertIsNone(store.get(session.upload_id))

    def test_tracks_out_of_order_chunks_and_assembles_source(self) -> None:
        store = UploadSessionStore()
        with tempfile.TemporaryDirectory(prefix="viveka_test_") as temp_dir:
            session = store.create(Path(temp_dir), "sample.wav", 9)

            (session.chunks_dir / "000002.part").write_bytes(b"BBB")
            (session.chunks_dir / "000001.part").write_bytes(b"AAA")
            (session.chunks_dir / "000003.part").write_bytes(b"CCC")

            store.record_chunk(session.upload_id, 2, 3, 3)
            store.record_chunk(session.upload_id, 1, 3, 3)
            store.record_chunk(session.upload_id, 3, 3, 3)

            self.assertTrue(store.is_complete(session.upload_id))

            _assemble_chunked_upload(session)
            self.assertEqual(session.source_path.read_bytes(), b"AAABBBCCC")


if __name__ == "__main__":
    unittest.main()