from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.main import UploadSessionStore


class UploadSessionStoreTests(unittest.TestCase):
    def test_create_update_and_pop_session(self) -> None:
        store = UploadSessionStore()
        with tempfile.TemporaryDirectory(prefix="viveka_test_") as temp_dir:
            session = store.create(Path(temp_dir), "sample.wav", 12345)
            self.assertEqual(session.received_bytes, 0)
            self.assertTrue(session.workspace.exists())
            self.assertEqual(store.get(session.upload_id).file_size_bytes, 12345)

            store.update_received_bytes(session.upload_id, 4096)
            self.assertEqual(store.get(session.upload_id).received_bytes, 4096)

            popped = store.pop(session.upload_id)
            self.assertEqual(popped.upload_id, session.upload_id)
            self.assertIsNone(store.get(session.upload_id))


if __name__ == "__main__":
    unittest.main()