from __future__ import annotations

from pathlib import Path
import sys
import unittest

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.main import app


class AuthHttpTests(unittest.TestCase):
    def test_preflight_accepts_common_vite_origin_on_api_v1_alias(self) -> None:
        client = TestClient(app)

        response = client.options(
            "/api/v1/auth/login",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("access-control-allow-origin"), "http://localhost:5173")

    def test_preflight_accepts_netlify_origin_on_api_v1_alias(self) -> None:
        client = TestClient(app)

        response = client.options(
            "/api/v1/auth/login",
            headers={
                "Origin": "https://viveka-version-4.netlify.app",
                "Access-Control-Request-Method": "POST",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers.get("access-control-allow-origin"),
            "https://viveka-version-4.netlify.app",
        )

    def test_api_v1_auth_login_alias_exists(self) -> None:
        client = TestClient(app)

        response = client.post(
            "/api/v1/auth/login",
            data={"username": "missing@example.com", "password": "bad-password"},
        )

        self.assertNotEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()