from __future__ import annotations

from pathlib import Path
import json
import os
import tempfile
import unittest

from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, patch

from backend.app.assessment_service import AssessmentService
from backend.app.asgi import MAX_BODY_BYTES, create_app
from backend.app.providers import MockVisionProvider, ProviderError
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
        self.assertEqual(value["prompt_version"], "anju_h5_camera_discovery_v3")
        self.assertEqual(value["rule_version"], "live-camera-rules-2026-07-26-v3")
        self.assertTrue(all(item["temporary"] for item in value["suggestions"]))
        self.assertTrue(all(item["short_advice"] for item in value["suggestions"]))
        self.assertTrue(all(item["risk_code"] in {rule["risk_code"] for rule in self.service.rules.live_camera_rules_for("h5_home")} for item in value["suggestions"]))
        count = self.service.repository.fetchone("SELECT COUNT(*) AS value FROM risks WHERE assessment_id=?", (assessment_id,))
        media_count = self.service.repository.fetchone("SELECT COUNT(*) AS value FROM media WHERE assessment_id=?", (assessment_id,))
        self.assertEqual(count["value"], 0)
        self.assertEqual(media_count["value"], 0)
        self.assertFalse(any((self.service.media_root / ".camera-tmp").glob("*")))

    def test_camera_discovery_rules_are_not_limited_by_scene_hint(self) -> None:
        class CrossSceneProvider(MockVisionProvider):
            def inspect_camera(self, assessment_id, room_type, media, camera_rules, profile_summary, previous_summary):
                self.assert_context = (room_type, {item["risk_code"] for item in camera_rules})
                usage = self._usage()
                usage["prompt_version"] = "anju_h5_camera_discovery_v3"
                return {
                    "media_id": media["media_id"], "quality_usable": True, "scene_elements": [],
                    "suggestions": [{
                        "risk_code": "high_reach_item", "title": "模型自由标题", "evidence": "画面中物品位于高处",
                        "confidence": .86, "needs_manual_check": False, "possible_repeat": False,
                        "region": {"type": "bbox", "x": .3, "y": .1, "width": .3, "height": .3, "points": None},
                    }],
                    "save_as_evidence_recommended": True,
                }, usage

        provider = CrossSceneProvider()
        self.service._provider = provider
        assessment_id, token = self.create_assessment()
        response = self.client.post(
            f"/api/v2/assessments/{assessment_id}/camera/frames:inspect",
            headers={
                **self.auth(token), "Content-Type": "image/jpeg", "X-Image-Width": "960", "X-Image-Height": "720",
                "X-Camera-Context": '{"frame_id":"cross-scene","room_type":"bathroom","previous_summary":[]}',
            },
            content=b"\xff\xd8\xffcamera-frame",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(provider.assert_context[0], "bathroom")
        self.assertIn("high_reach_item", provider.assert_context[1])
        suggestion = response.json()["suggestions"][0]
        self.assertEqual(suggestion["title"], "常用物品放得过高")
        self.assertEqual(suggestion["short_advice"], "把常用物品移到肩部以下")

    def test_camera_regions_preserve_valid_shapes_and_drop_invalid_coordinates(self) -> None:
        class RegionProvider(MockVisionProvider):
            def inspect_camera(self, assessment_id, room_type, media, camera_rules, profile_summary, previous_summary):
                return {
                    "media_id": media["media_id"], "quality_usable": True, "scene_elements": [],
                    "suggestions": [
                        {
                            "risk_code": "floor_clutter", "evidence": "通道中有纸箱", "confidence": .9,
                            "needs_manual_check": False, "possible_repeat": False,
                            "region": {"type": "polygon", "points": [[.1, .2], [.4, .2], [.3, .5]]},
                        },
                        {
                            "risk_code": "floor_clutter", "evidence": "另一处通道杂物", "confidence": .8,
                            "needs_manual_check": True, "possible_repeat": False,
                            "region": {"type": "bbox", "x": .9, "y": .2, "width": .3, "height": .2},
                        },
                    ],
                    "save_as_evidence_recommended": True,
                }, self._usage()

        self.service._provider = RegionProvider()
        assessment_id, token = self.create_assessment()
        response = self.client.post(
            f"/api/v2/assessments/{assessment_id}/camera/frames:inspect",
            headers={
                **self.auth(token), "Content-Type": "image/jpeg", "X-Image-Width": "960", "X-Image-Height": "720",
                "X-Camera-Context": '{"frame_id":"region-frame","room_type":"living_room","previous_summary":[]}',
            },
            content=b"\xff\xd8\xffcamera-frame",
        )
        self.assertEqual(response.status_code, 200)
        suggestions = response.json()["suggestions"]
        self.assertEqual(suggestions[0]["region"]["type"], "polygon")
        self.assertEqual(suggestions[0]["region"]["points"], [[.1, .2], [.4, .2], [.3, .5]])
        self.assertIsNone(suggestions[1]["region"])
        event = self.service.repository.fetchone(
            "SELECT payload_json FROM analytics_events WHERE assessment_id=? AND event_name='ai_call_completed' ORDER BY created_at DESC",
            (assessment_id,),
        )
        payload = json.loads(event["payload_json"])
        self.assertEqual(payload["candidate_count_region_raw"], 2)
        self.assertEqual(payload["candidate_count_region_validated"], 1)
        self.assertEqual(payload["candidate_count_region_rejected"], 1)

    def test_camera_provider_error_uses_safe_structured_response(self) -> None:
        class TimeoutProvider(MockVisionProvider):
            def inspect_camera(self, assessment_id, room_type, media, allowed_risks, profile_summary, previous_summary):
                raise ProviderError("provider_timeout")

        self.service._provider = TimeoutProvider()
        assessment_id, token = self.create_assessment()
        response = self.client.post(
            f"/api/v2/assessments/{assessment_id}/camera/frames:inspect",
            headers={
                **self.auth(token), "Content-Type": "image/jpeg", "X-Image-Width": "960", "X-Image-Height": "720",
                "X-Camera-Context": '{"frame_id":"frame-timeout","room_type":"bathroom","previous_summary":[]}',
            },
            content=b"\xff\xd8\xffcamera-frame",
        )
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["code"], "provider_timeout")
        self.assertTrue(response.json()["request_id"])
        self.assertEqual(response.headers["x-request-id"], response.json()["request_id"])

    def test_camera_model_work_is_dispatched_to_threadpool(self) -> None:
        assessment_id, token = self.create_assessment()
        result = {
            "frame_id": "thread-frame", "temporary": True, "quality_usable": True,
            "scene_elements": [], "suggestions": [], "save_as_evidence_recommended": False,
            "prompt_version": "anju_h5_camera_discovery_v3", "rule_version": "test",
        }
        with patch("backend.app.asgi.run_in_threadpool", new=AsyncMock(return_value=result)) as dispatched:
            response = self.client.post(
                f"/api/v2/assessments/{assessment_id}/camera/frames:inspect",
                headers={
                    **self.auth(token), "Content-Type": "image/jpeg", "X-Image-Width": "960", "X-Image-Height": "720",
                    "X-Camera-Context": '{"frame_id":"thread-frame","room_type":"living_room","previous_summary":[]}',
                },
                content=b"\xff\xd8\xffcamera-frame",
            )
        self.assertEqual(response.status_code, 200)
        dispatched.assert_awaited_once()
        self.assertIs(dispatched.await_args.args[0].__self__, self.service)
        self.assertEqual(dispatched.await_args.args[0].__name__, "inspect_camera_frame")

    def test_fair_camera_analysis_and_deterministic_report(self) -> None:
        created = self.client.post("/api/v2/fair-scans")
        self.assertEqual(created.status_code, 201)
        scan = created.json()
        auth = self.auth(scan["access_token"])
        denied = self.client.get(f"/api/v2/fair-scans/{scan['scan_id']}/report")
        self.assertEqual(denied.status_code, 404)
        for index in range(2):
            analyzed = self.client.post(
                f"/api/v2/fair-scans/{scan['scan_id']}/zones/entrance/frames:analyze",
                headers={**auth, "Content-Type": "image/jpeg", "X-Frame-ID": f"fair-frame-{index}", "X-Image-Width": "1280", "X-Image-Height": "720", "X-Model-Image-Orientation": "right"},
                content=b"\xff\xd8\xfffair-frame" + bytes([index]),
            )
            self.assertEqual(analyzed.status_code, 200)
            self.assertEqual(analyzed.json()["prompt_version"], "anju_ios_fair_camera_direct_v3")
            self.assertEqual(analyzed.json()["rule_version"], "venue-fair-rules-2026-07-26-v2")
            self.assertTrue(all(item["title"] and item["short_advice"] for item in analyzed.json()["candidates"]))
            self.assertTrue(analyzed.json()["candidates"])
        finalized = self.client.post(f"/api/v2/fair-scans/{scan['scan_id']}/zones/entrance:finalize", headers=auth)
        self.assertEqual(finalized.status_code, 200)
        self.assertEqual(finalized.json()["prompt_version"], "anju_ios_fair_camera_direct_v3")
        self.assertEqual(finalized.json()["rule_version"], "venue-fair-rules-2026-07-26-v2")
        self.assertEqual(len(finalized.json()["risks"]), 1)
        report = self.client.get(f"/api/v2/fair-scans/{scan['scan_id']}/report", headers=auth)
        self.assertEqual(report.status_code, 200)
        self.assertEqual(report.json()["coverage_percent"], 25)
        self.assertLess(report.json()["assessed_area_score"], 100)
        self.assertEqual([item["tier"] for item in report.json()["zones"][0]["risks"][0]["solutions"]], ["A", "B", "C"])
        self.assertTrue(all(item["score_eligible"] for item in report.json()["zones"][0]["risks"]))
        self.assertEqual(report.json()["rule_version"], "venue-fair-rules-2026-07-26-v2")

    def test_fair_camera_provider_error_is_structured_and_audited(self) -> None:
        class TimeoutProvider(MockVisionProvider):
            def fair_analyze(self, scan_id, zone_id, media, allowed_risks):
                raise ProviderError("provider_timeout")

        self.service._provider = TimeoutProvider()
        scan = self.client.post("/api/v2/fair-scans").json()
        response = self.client.post(
            f"/api/v2/fair-scans/{scan['scan_id']}/zones/entrance/frames:analyze",
            headers={
                **self.auth(scan["access_token"]), "Content-Type": "image/jpeg", "X-Frame-ID": "fair-timeout",
                "X-Image-Width": "1280", "X-Image-Height": "720", "X-Model-Image-Orientation": "right",
            },
            content=b"\xff\xd8\xfffair-frame",
        )
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["code"], "provider_timeout")
        event = self.service.repository.fetchone(
            "SELECT payload_json FROM analytics_events WHERE assessment_id=? AND event_name='ai_call_failed'",
            (scan["scan_id"],),
        )
        self.assertIsNotNone(event)
        self.assertIn('"skill_name": "fair_camera_analysis"', event["payload_json"])

    def test_encoded_ios_fair_action_paths_are_routed(self) -> None:
        scan = self.client.post("/api/v2/fair-scans").json()
        auth = self.auth(scan["access_token"])
        analyzed = self.client.post(
            f"/api/v2/fair-scans/{scan['scan_id']}/zones/entrance/frames%253Aanalyze",
            headers={
                **auth, "Content-Type": "image/jpeg", "X-Frame-ID": "encoded-action-frame",
                "X-Image-Width": "1280", "X-Image-Height": "720", "X-Model-Image-Orientation": "right",
            },
            content=b"\xff\xd8\xffencoded-action-frame",
        )
        self.assertEqual(analyzed.status_code, 200)
        finalized = self.client.post(
            f"/api/v2/fair-scans/{scan['scan_id']}/zones/entrance%253Afinalize",
            headers=auth,
        )
        self.assertEqual(finalized.status_code, 200)

    def test_missing_frontend_build_returns_503(self) -> None:
        root = Path(self.temp.name) / "missing-static"
        app = create_app(assessment_service=self.service, static_root=root)
        with TestClient(app) as client:
            response = client.get("/")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "frontend_not_built")


if __name__ == "__main__":
    unittest.main()
