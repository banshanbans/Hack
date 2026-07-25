from __future__ import annotations

from pathlib import Path
import os
import tempfile
import unittest

from fastapi.testclient import TestClient
from unittest.mock import patch

from backend.app.assessment_service import AssessmentService
from backend.app.asgi import MAX_BODY_BYTES, create_app
from backend.app.providers import MockVisionProvider
from backend.app.repositories import SQLiteRepository


class V2APITests(unittest.TestCase):
    def setUp(self) -> None:
        self.feature_flags = patch.dict(os.environ, {"ANJU_ENABLE_H5_VIDEO": "1", "ANJU_ENABLE_H5_CAMERA": "1", "ANJU_ENABLE_IOS_FAIR_AR": "1"})
        self.feature_flags.start()
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        static = root / "static"
        static.mkdir()
        (static / "index.html").write_text("<!doctype html><title>长者友好家</title>", encoding="utf-8")
        (static / "assets").mkdir()
        (static / "assets" / "app.js").write_text("export {};", encoding="utf-8")
        self.service = AssessmentService(SQLiteRepository(root / "api.db"), root / "media", provider=MockVisionProvider())
        self.client_context = TestClient(create_app(assessment_service=self.service, static_root=static))
        self.client = self.client_context.__enter__()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.service.close()
        self.temp.cleanup()
        self.feature_flags.stop()

    def create_assessment(self) -> tuple[str, str]:
        response = self.client.post("/api/v2/assessments", json={"input_mode": "photo"})
        self.assertEqual(response.status_code, 201)
        value = response.json()
        return value["assessment_id"], value["access_token"]

    @staticmethod
    def auth(token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    def test_static_health_v1_and_authenticated_v2(self) -> None:
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["version"], "v2")
        self.assertEqual(health.headers["cache-control"], "no-store")
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("default-src 'self'", page.headers["content-security-policy"])
        self.assertEqual(page.headers["cache-control"], "no-cache")
        asset = self.client.get("/assets/app.js")
        self.assertEqual(asset.status_code, 200)
        self.assertEqual(asset.headers["cache-control"], "public, max-age=31536000, immutable")

        legacy = self.client.post("/api/v1/sessions", json={"room_type": "bathroom", "profiles": []})
        self.assertEqual(legacy.status_code, 201)
        self.assertIn("session_id", legacy.json())

        assessment_id, token = self.create_assessment()
        denied = self.client.get(f"/api/v2/assessments/{assessment_id}")
        self.assertEqual(denied.status_code, 404)
        self.assertEqual(denied.json()["code"], "assessment_access_denied")
        profile = self.client.put(
            f"/api/v2/assessments/{assessment_id}/profile",
            headers=self.auth(token),
            json={"mobility": "normal", "fall_history": "none", "living_status": "with_family"},
        )
        self.assertEqual(profile.status_code, 200)
        self.assertEqual(profile.json()["mobility"], "normal")

        plan = self.client.put(
            f"/api/v2/assessments/{assessment_id}/planned-rooms",
            headers=self.auth(token),
            json={"planned_rooms": ["bathroom", "bedroom"]},
        )
        self.assertEqual(plan.status_code, 200)
        self.assertEqual(plan.json()["planned_rooms"], ["bathroom", "bedroom"])
        refreshed = self.client.get(f"/api/v2/assessments/{assessment_id}", headers=self.auth(token)).json()
        self.assertEqual(refreshed["planned_rooms"], ["bathroom", "bedroom"])

    def test_raw_media_response_and_read_only_share(self) -> None:
        assessment_id, token = self.create_assessment()
        auth = self.auth(token)
        self.client.put(
            f"/api/v2/assessments/{assessment_id}/profile",
            headers=auth,
            json={"mobility": "normal", "fall_history": "none", "living_status": "with_family"},
        )
        room = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms",
            headers=auth,
            json={"room_type": "bathroom"},
        ).json()
        jpeg = b"\xff\xd8\xff" + b"fastapi-media"
        upload = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room['room_id']}/media",
            headers={**auth, "Content-Type": "image/jpeg", "X-Image-Width": "1200", "X-Image-Height": "900"},
            content=jpeg,
        )
        self.assertEqual(upload.status_code, 201)
        media_id = upload.json()["media_id"]
        denied = self.client.get(f"/api/v2/assessments/{assessment_id}/media/{media_id}/content")
        self.assertEqual(denied.status_code, 404)
        content = self.client.get(f"/api/v2/assessments/{assessment_id}/media/{media_id}/content", headers=auth)
        self.assertEqual(content.status_code, 200)
        self.assertEqual(content.content, jpeg)
        self.assertEqual(content.headers["cache-control"], "no-store")

        share = self.client.post(f"/api/v2/assessments/{assessment_id}/share", headers=auth)
        self.assertEqual(share.status_code, 201)
        shared = self.client.get(share.json()["path"].replace("/#/share/", "/api/v2/shared-reports/"))
        self.assertEqual(shared.status_code, 200)
        serialized = shared.text
        self.assertNotIn("profile_json", serialized)
        self.assertNotIn("content_path", serialized)

    def test_validation_and_body_limit_use_product_error_envelope(self) -> None:
        assessment_id, token = self.create_assessment()
        invalid = self.client.put(
            f"/api/v2/assessments/{assessment_id}/profile",
            headers=self.auth(token),
            json={"mobility": "normal"},
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.json()["code"], "invalid_request")

        room = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms",
            headers=self.auth(token),
            json={"room_type": "bathroom"},
        ).json()
        too_large = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room['room_id']}/media",
            headers={**self.auth(token), "Content-Type": "image/jpeg", "X-Image-Width": "10", "X-Image-Height": "10"},
            content=b"x" * (MAX_BODY_BYTES + 1),
        )
        self.assertEqual(too_large.status_code, 413)
        self.assertEqual(too_large.json()["code"], "request_too_large")

    def test_camera_inspection_is_temporary_and_does_not_create_formal_risks(self) -> None:
        assessment_id, token = self.create_assessment()
        response = self.client.post(
            f"/api/v2/assessments/{assessment_id}/camera/frames:inspect",
            headers={
                **self.auth(token), "Content-Type": "image/jpeg", "X-Image-Width": "960", "X-Image-Height": "720",
                "X-Camera-Context": '{"frame_id":"frame-1","room_type":"bathroom","previous_summary":[]}',
            },
            content=b"\xff\xd8\xffcamera-frame",
        )
        self.assertEqual(response.status_code, 200)
        value = response.json()
        self.assertTrue(value["temporary"])
        self.assertEqual(value["prompt_version"], "anju_h5_camera_adaptive_v1")
        self.assertTrue(all(item["temporary"] for item in value["suggestions"]))
        count = self.service.repository.fetchone("SELECT COUNT(*) AS value FROM risks WHERE assessment_id=?", (assessment_id,))
        media_count = self.service.repository.fetchone("SELECT COUNT(*) AS value FROM media WHERE assessment_id=?", (assessment_id,))
        self.assertEqual(count["value"], 0)
        self.assertEqual(media_count["value"], 0)
        self.assertFalse(any((self.service.media_root / ".camera-tmp").glob("*")))

    def test_fair_turbo_pro_review_and_deterministic_report(self) -> None:
        created = self.client.post("/api/v2/fair-scans")
        self.assertEqual(created.status_code, 201)
        scan = created.json()
        auth = self.auth(scan["access_token"])
        denied = self.client.get(f"/api/v2/fair-scans/{scan['scan_id']}/report")
        self.assertEqual(denied.status_code, 404)
        for index in range(2):
            turbo = self.client.post(
                f"/api/v2/fair-scans/{scan['scan_id']}/zones/entrance/frames:turbo",
                headers={**auth, "Content-Type": "image/jpeg", "X-Frame-ID": f"fair-frame-{index}", "X-Image-Width": "1280", "X-Image-Height": "720", "X-Model-Image-Orientation": "right"},
                content=b"\xff\xd8\xfffair-frame" + bytes([index]),
            )
            self.assertEqual(turbo.status_code, 200)
            self.assertEqual(turbo.json()["prompt_version"], "anju_ios_fair_turbo_v1")
            self.assertTrue(turbo.json()["candidates"])
        reviewed = self.client.post(f"/api/v2/fair-scans/{scan['scan_id']}/zones/entrance:review", headers=auth)
        self.assertEqual(reviewed.status_code, 200)
        self.assertEqual(reviewed.json()["prompt_version"], "anju_ios_fair_review_pro_v1")
        self.assertEqual(len(reviewed.json()["risks"]), 2)
        report = self.client.get(f"/api/v2/fair-scans/{scan['scan_id']}/report", headers=auth)
        self.assertEqual(report.status_code, 200)
        self.assertEqual(report.json()["coverage_percent"], 25)
        self.assertLess(report.json()["assessed_area_score"], 100)
        self.assertEqual([item["tier"] for item in report.json()["zones"][0]["risks"][0]["solutions"]], ["A", "B", "C"])

    def test_missing_frontend_build_returns_503(self) -> None:
        root = Path(self.temp.name) / "missing-static"
        app = create_app(assessment_service=self.service, static_root=root)
        with TestClient(app) as client:
            response = client.get("/")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "frontend_not_built")


if __name__ == "__main__":
    unittest.main()
