from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import os
import tempfile
import threading
import time
import unittest
import uuid

from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, patch

from backend.app.assessment_service import AssessmentService
from backend.app.asgi import MAX_BODY_BYTES, create_app
from backend.app.providers import MockKnowledgeAdvisorProvider, MockRenovationProvider, MockVisionProvider, ProviderError
from backend.app.repositories import SQLiteRepository


class V2APITests(unittest.TestCase):
    def setUp(self) -> None:
        self.feature_flags = patch.dict(os.environ, {
            "ANJU_ENABLE_H5_VIDEO": "1", "ANJU_ENABLE_H5_CAMERA": "1",
            "ANJU_ENABLE_IOS_HOME_CAMERA": "1", "ANJU_ENABLE_RENOVATION_PREVIEW": "1",
            "ANJU_ENABLE_VOICE_ADVISOR": "0", "ANJU_ENABLE_RTC_VIDEO_ADVISOR": "0",
            "ANJU_ENABLE_KNOWLEDGE_ADVISOR": "1",
        })
        self.feature_flags.start()
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        static = root / "static"
        static.mkdir()
        (static / "index.html").write_text("<!doctype html><title>长者友好家</title>", encoding="utf-8")
        (static / "assets").mkdir()
        (static / "assets" / "app.js").write_text("export {};", encoding="utf-8")
        self.service = AssessmentService(
            SQLiteRepository(root / "api.db"), root / "media", provider=MockVisionProvider(),
            renovation_provider=MockRenovationProvider(), knowledge_advisor_provider=MockKnowledgeAdvisorProvider(),
        )
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

    def create_formal_advisor_context(self) -> dict[str, str]:
        assessment_id, token = self.create_assessment()
        auth = self.auth(token)
        self.client.put(
            f"/api/v2/assessments/{assessment_id}/profile", headers=auth,
            json={"mobility": "normal", "fall_history": "none", "living_status": "with_family"},
        )
        room_id = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms", headers=auth,
            json={"room_type": "bathroom"},
        ).json()["room_id"]
        self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/media",
            headers={**auth, "Content-Type": "image/jpeg", "X-Image-Width": "1200", "X-Image-Height": "900"},
            content=b"\xff\xd8\xffadvisor-formal",
        )
        self.client.post(f"/api/v2/assessments/{assessment_id}/rooms/{room_id}:analyze", headers=auth)
        deadline = time.time() + 3
        while time.time() < deadline:
            status = self.client.get(
                f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/status", headers=auth,
            ).json()
            if status["status"] in {"completed", "failed"}:
                break
            time.sleep(.02)
        self.assertEqual(status["status"], "completed")
        risk_id = self.client.get(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/result", headers=auth,
        ).json()["risks"][0]["risk_id"]
        solution_id = self.client.get(
            f"/api/v2/assessments/{assessment_id}/risks/{risk_id}/solutions", headers=auth,
        ).json()["solutions"][0]["solution_package_id"]
        session_id = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions",
            headers=auth, json={"context_refs": {"risk_id": risk_id}},
        ).json()["session_id"]
        return {
            "assessment_id": assessment_id, "token": token, "room_id": room_id,
            "risk_id": risk_id, "solution_id": solution_id, "session_id": session_id,
        }

    def test_knowledge_advisor_anonymous_lifecycle_and_independent_token(self) -> None:
        health = self.client.get("/health").json()
        self.assertTrue(health["capabilities"]["knowledge_advisor"])
        created_response = self.client.post("/api/v2/knowledge-advisor/sessions")
        self.assertEqual(created_response.status_code, 201)
        created = created_response.json()
        session_id = created["session_id"]
        access_token = created["access_token"]
        self.assertEqual(len(created["quick_prompts"]), 6)
        self.assertEqual(created["welcome_title"], "我是长者友好家AI居家顾问，有任何适老化改造问题都可以问我")

        denied = self.client.get(f"/api/v2/knowledge-advisor/sessions/{session_id}")
        self.assertEqual(denied.status_code, 401)
        restored = self.client.get(
            f"/api/v2/knowledge-advisor/sessions/{session_id}", headers=self.auth(access_token),
        )
        self.assertEqual(restored.status_code, 200)
        message = self.client.post(
            f"/api/v2/knowledge-advisor/sessions/{session_id}/messages",
            headers=self.auth(access_token), json={"text": "卫生间扶手怎么选？"},
        )
        self.assertEqual(message.status_code, 200)
        self.assertIn("可靠基层", message.json()["assistant_turn"]["text"])
        transcript_payload = {"role": "assistant", "text": "这是最终语音字幕", "provider_event_id": "voice-event-1"}
        first = self.client.post(
            f"/api/v2/knowledge-advisor/sessions/{session_id}/transcripts",
            headers=self.auth(access_token), json=transcript_payload,
        )
        second = self.client.post(
            f"/api/v2/knowledge-advisor/sessions/{session_id}/transcripts",
            headers=self.auth(access_token), json=transcript_payload,
        )
        self.assertEqual(first.json()["turn_id"], second.json()["turn_id"])
        self.assertEqual(self.service.repository.fetchone("SELECT COUNT(*) AS value FROM assessments")["value"], 0)

        deleted = self.client.delete(
            f"/api/v2/knowledge-advisor/sessions/{session_id}", headers=self.auth(access_token),
        )
        self.assertEqual(deleted.status_code, 204)
        self.assertIsNone(self.service.repository.fetchone(
            "SELECT id FROM knowledge_advisor_sessions WHERE id=?", (session_id,),
        ))

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

    def test_renovation_preview_api_is_authenticated_persisted_and_reported(self) -> None:
        assessment_id, token = self.create_assessment()
        auth = self.auth(token)
        self.client.put(f"/api/v2/assessments/{assessment_id}/profile", headers=auth, json={"mobility": "cane", "fall_history": "once", "living_status": "alone"})
        room = self.client.post(f"/api/v2/assessments/{assessment_id}/rooms", headers=auth, json={"room_type": "bathroom"}).json()
        upload = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room['room_id']}/media",
            headers={**auth, "Content-Type": "image/jpeg", "X-Image-Width": "1200", "X-Image-Height": "900"},
            content=b"\xff\xd8\xffrenovation-api",
        ).json()
        self.client.post(f"/api/v2/assessments/{assessment_id}/rooms/{room['room_id']}:analyze", headers=auth)
        deadline = time.time() + 3
        while time.time() < deadline:
            status = self.client.get(f"/api/v2/assessments/{assessment_id}/rooms/{room['room_id']}/status", headers=auth).json()
            if status["status"] in {"completed", "failed"}: break
            time.sleep(.02)
        result = self.client.get(f"/api/v2/assessments/{assessment_id}/rooms/{room['room_id']}/result", headers=auth).json()
        risk = result["risks"][0]
        solutions = self.client.get(f"/api/v2/assessments/{assessment_id}/risks/{risk['risk_id']}/solutions", headers=auth).json()["solutions"]
        selected = next(item for item in solutions if item["tier"] == "B")
        self.client.put(f"/api/v2/assessments/{assessment_id}/risks/{risk['risk_id']}/selected-solution", headers=auth, json={"solution_package_id": selected["solution_package_id"]})

        context_path = f"/api/v2/assessments/{assessment_id}/rooms/{room['room_id']}/renovation-preview-context"
        denied = self.client.get(context_path)
        self.assertEqual(denied.status_code, 404)
        context = self.client.get(context_path, headers=auth).json()
        self.assertEqual(context["eligible_media"][0]["media_id"], upload["media_id"])
        created = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room['room_id']}/renovation-previews",
            headers=auth, json={"source_media_id": upload["media_id"]},
        )
        self.assertEqual(created.status_code, 201)
        preview_id = created.json()["preview_id"]
        preview_path = f"/api/v2/assessments/{assessment_id}/rooms/{room['room_id']}/renovation-previews/{preview_id}"
        while time.time() < deadline + 3:
            preview = self.client.get(preview_path, headers=auth).json()
            if preview["status"] in {"completed", "failed"}: break
            time.sleep(.02)
        self.assertEqual(preview["status"], "completed")
        content_path = preview["after_content_path"]
        self.assertEqual(self.client.get(content_path).status_code, 404)
        self.assertEqual(self.client.get(content_path, headers=auth).content, b"\xff\xd8\xffrenovation-api")
        chosen = self.client.put(f"{preview_path}:select", headers=auth)
        self.assertEqual(chosen.status_code, 200)
        self.assertTrue(chosen.json()["selected_for_report"])
        report = self.client.get(f"/api/v2/assessments/{assessment_id}/report", headers=auth).json()
        self.assertEqual(report["renovation_previews"][0]["preview_id"], preview_id)
        share = self.client.post(f"/api/v2/assessments/{assessment_id}/share", headers=auth).json()
        shared = self.client.get(share["path"].replace("/#/share/", "/api/v2/shared-reports/")).json()
        shared_after = shared["renovation_previews"][0]["after_content_path"]
        self.assertIn(f"/shared-reports/{share['token']}/renovation-previews/{preview_id}/after", shared_after)
        self.assertEqual(self.client.get(shared_after).content, b"\xff\xd8\xffrenovation-api")

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
        self.assertEqual(value["prompt_version"], "anju_home_camera_discovery_v1")
        self.assertEqual(value["rule_version"], "live-camera-rules-2026-07-26-v3")
        self.assertTrue(all(item["temporary"] for item in value["suggestions"]))
        self.assertTrue(all(item["short_advice"] for item in value["suggestions"]))
        self.assertTrue(all(item["risk_code"] in {rule["risk_code"] for rule in self.service.rules.live_camera_rules_for("h5_home")} for item in value["suggestions"]))
        count = self.service.repository.fetchone("SELECT COUNT(*) AS value FROM risks WHERE assessment_id=?", (assessment_id,))
        media_count = self.service.repository.fetchone("SELECT COUNT(*) AS value FROM media WHERE assessment_id=?", (assessment_id,))
        self.assertEqual(count["value"], 0)
        self.assertEqual(media_count["value"], 0)
        self.assertFalse(any((self.service.media_root / ".camera-tmp").glob("*")))

    def test_advisor_draft_history_and_confirmation_gate(self) -> None:
        assessment_id, token = self.create_assessment()
        auth = self.auth(token)
        room = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms",
            headers=auth,
            json={"room_type": "bathroom"},
        ).json()
        room_id = room["room_id"]
        camera = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/camera/sessions",
            headers=auth,
        )
        self.assertEqual(camera.status_code, 201)
        camera_session_id = camera.json()["camera_session_id"]
        inspected = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/camera/frames:inspect",
            headers={
                **auth, "Content-Type": "image/jpeg", "X-Image-Width": "960", "X-Image-Height": "720",
                "X-Camera-Context": json.dumps({
                    "frame_id": "advisor-frame", "previous_summary": [],
                    "source_kind": "h5_camera_frame", "camera_session_id": camera_session_id,
                }),
            },
            content=b"\xff\xd8\xffadvisor-camera-frame",
        )
        self.assertEqual(inspected.status_code, 200)
        upload = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/media",
            headers={**auth, "Content-Type": "image/jpeg", "X-Image-Width": "960", "X-Image-Height": "720", "X-Media-Source-Kind": "h5_camera_frame"},
            content=b"\xff\xd8\xffadvisor-representative",
        ).json()
        completed = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/camera/sessions/{camera_session_id}:complete",
            headers=auth,
            json={"media_ids": [upload["media_id"]]},
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(self.service.repository.fetchone(
            "SELECT COUNT(*) AS value FROM jobs WHERE assessment_id=?", (assessment_id,),
        )["value"], 0)
        self.assertEqual(self.service.repository.fetchone(
            "SELECT COUNT(*) AS value FROM risks WHERE assessment_id=?", (assessment_id,),
        )["value"], 0)
        self.assertEqual(self.service.repository.fetchone(
            "SELECT COUNT(*) AS value FROM analytics_events WHERE assessment_id=? AND event_name='analysis_started'",
            (assessment_id,),
        )["value"], 0)

        bootstrap = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions",
            headers=auth,
            json={"camera_session_id": camera_session_id, "context_refs": {"media_id": upload["media_id"]}},
        )
        self.assertEqual(bootstrap.status_code, 201)
        payload = bootstrap.json()
        self.assertEqual(payload["phase"], "draft")
        self.assertFalse(payload["rtc"]["available"])
        self.assertEqual(payload["current_media"]["media_id"], upload["media_id"])
        self.assertEqual(payload["prompt_version"], "anju_voice_advisor_v1")
        self.assertEqual(payload["quick_prompts"], ["这个地方可能有什么问题？", "这里能不能加扶手？", "还需要拍哪里？"])
        self.assertTrue(payload["suggestions"])
        suggestion = payload["suggestions"][0]
        self.assertEqual(suggestion["frame_id"], "advisor-frame")
        session_id = payload["session_id"]
        events = payload["events"]
        self.assertNotIn("access_token", events["websocket_path"])
        with self.client.websocket_connect(f'{events["websocket_path"]}?token={events["token"]}') as websocket:
            ready = websocket.receive_json()
            self.assertEqual(ready, {"type": "ready", "session_id": session_id})
        consumed = self.service.repository.fetchone(
            "SELECT event_token_used_at FROM advisor_sessions WHERE id=?", (session_id,),
        )
        self.assertIsNotNone(consumed["event_token_used_at"])
        token_path = (
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}"
            f"/advisor/sessions/{session_id}/events-token"
        )
        first_refresh = self.client.post(token_path, headers=auth)
        second_refresh = self.client.post(token_path, headers=auth)
        self.assertEqual(first_refresh.status_code, 200)
        self.assertEqual(second_refresh.status_code, 200)
        self.assertFalse(self.service.advisor.consume_event_token(
            assessment_id, room_id, session_id, first_refresh.json()["token"],
        ))
        self.assertTrue(self.service.advisor.consume_event_token(
            assessment_id, room_id, session_id, second_refresh.json()["token"],
        ))
        self.assertFalse(self.service.advisor.consume_event_token(
            assessment_id, room_id, session_id, second_refresh.json()["token"],
        ))
        other_assessment_id, other_token = self.create_assessment()
        unauthorized_refresh = self.client.post(token_path, headers=self.auth(other_token))
        self.assertEqual(unauthorized_refresh.status_code, 404)
        self.assertNotEqual(other_assessment_id, assessment_id)

        answer = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/messages",
            headers=auth,
            json={"text": "预算大概多少？", "context_refs": {"media_id": upload["media_id"]}},
        )
        self.assertEqual(answer.status_code, 200)
        self.assertIn("不能据此给出预算", answer.json()["assistant_turn"]["text"])
        self.assertNotRegex(answer.json()["assistant_turn"]["text"], r"[高中低]风险|[¥￥]\s*\d")

        ambiguous = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/messages",
            headers=auth,
            json={"text": "这个地方可能有什么问题？", "context_refs": {"camera_session_id": camera_session_id}},
        )
        self.assertEqual(ambiguous.status_code, 200)
        self.assertIn("请先点选", ambiguous.json()["assistant_turn"]["text"])

        selected = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/messages",
            headers=auth,
            json={
                "text": "这个地方可能有什么问题？",
                "context_refs": {
                    "camera_session_id": camera_session_id,
                    "camera_suggestion_id": suggestion["suggestion_id"],
                    "frame_id": suggestion["frame_id"],
                },
            },
        )
        self.assertEqual(selected.status_code, 200)
        self.assertIn(suggestion["title"], selected.json()["assistant_turn"]["text"])
        forged = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/messages",
            headers=auth,
            json={
                "text": "解释这里",
                "context_refs": {
                    "camera_session_id": camera_session_id,
                    "camera_suggestion_id": str(uuid.uuid4()),
                },
            },
        )
        self.assertEqual(forged.status_code, 404)
        self.assertEqual(forged.json()["code"], "camera_suggestion_not_found")

        voice = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/voice",
            headers=auth,
        )
        self.assertEqual(voice.status_code, 200)
        self.assertFalse(voice.json()["available"])

        request_analysis = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/messages",
            headers=auth,
            json={
                "text": "开始正式分析", "context_refs": {"media_id": upload["media_id"]},
                "requested_action": {"tool_name": "start_formal_analysis", "arguments": {}},
            },
        ).json()
        confirmation = request_analysis["assistant_turn"]["cards"][0]
        denied = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/confirmations/{confirmation['confirmation_id']}",
            headers=auth,
            json={"approved": True},
        )
        self.assertEqual(denied.status_code, 409)
        self.assertEqual(denied.json()["code"], "profile_incomplete")
        turns = self.client.get(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/turns",
            headers=auth,
        ).json()["turns"]
        self.assertGreaterEqual(len(turns), 5)
        self.assertTrue(all("audio" not in json.dumps(turn) for turn in turns))

    def test_advisor_confirmation_is_claimed_once_and_history_uses_current_state(self) -> None:
        context = self.create_formal_advisor_context()
        assessment_id = context["assessment_id"]
        room_id = context["room_id"]
        session_id = context["session_id"]
        risk_id = context["risk_id"]
        solution_id = context["solution_id"]
        auth = self.auth(context["token"])
        message_path = (
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}"
            f"/advisor/sessions/{session_id}/messages"
        )
        solutions_turn = self.client.post(
            message_path, headers=auth,
            json={"text": "这个怎么改？", "context_refs": {"risk_id": risk_id}},
        ).json()["assistant_turn"]
        self.assertEqual(solutions_turn["cards"][0]["type"], "solution_options")
        requested = self.client.post(
            message_path, headers=auth,
            json={
                "text": "加入改造清单", "context_refs": {"risk_id": risk_id},
                "requested_action": {"tool_name": "select_solution", "arguments": {
                    "risk_id": risk_id, "solution_package_id": solution_id,
                }},
            },
        ).json()["assistant_turn"]
        confirmation_id = requested["cards"][0]["confirmation_id"]
        workers = 6
        barrier = threading.Barrier(workers)

        def approve(_: int) -> tuple[str, str]:
            barrier.wait()
            try:
                result = self.service.advisor.decide_confirmation(
                    assessment_id, room_id, session_id, confirmation_id, True,
                )
                return "ok", result["status"]
            except Exception as error:
                return "error", getattr(error, "code", "unknown")

        with ThreadPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(approve, range(workers)))
        self.assertEqual(results.count(("ok", "approved")), 1)
        self.assertTrue(all(
            result == ("ok", "approved") or result[1] in {
                "advisor_confirmation_in_progress", "advisor_confirmation_already_decided",
            }
            for result in results
        ))
        self.assertEqual(self.service.repository.fetchone(
            "SELECT COUNT(*) AS value FROM selected_solutions WHERE risk_id=?", (risk_id,),
        )["value"], 1)
        self.assertEqual(self.service.repository.fetchone(
            "SELECT COUNT(*) AS value FROM analytics_events WHERE assessment_id=? "
            "AND event_name='solution_added_to_plan'", (assessment_id,),
        )["value"], 1)

        turns = self.client.get(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/turns",
            headers=auth,
        ).json()["turns"]
        solution_cards = [card for turn in turns for card in turn["cards"] if card["type"] == "solution_options"]
        confirmation_cards = [card for turn in turns for card in turn["cards"] if card["type"] == "confirmation"]
        self.assertEqual(solution_cards[-1]["selected_solution_package_id"], solution_id)
        self.assertEqual(confirmation_cards[-1]["status"], "approved")

    def test_advisor_approve_reject_race_has_one_winner_and_processing_recovers_as_failed(self) -> None:
        context = self.create_formal_advisor_context()
        assessment_id = context["assessment_id"]
        room_id = context["room_id"]
        session_id = context["session_id"]
        risk_id = context["risk_id"]
        solution_id = context["solution_id"]
        requested = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/messages",
            headers=self.auth(context["token"]),
            json={
                "text": "是否加入清单", "context_refs": {"risk_id": risk_id},
                "requested_action": {"tool_name": "select_solution", "arguments": {
                    "risk_id": risk_id, "solution_package_id": solution_id,
                }},
            },
        ).json()["assistant_turn"]
        confirmation_id = requested["cards"][0]["confirmation_id"]
        barrier = threading.Barrier(2)

        def decide(approved: bool) -> tuple[str, str]:
            barrier.wait()
            try:
                result = self.service.advisor.decide_confirmation(
                    assessment_id, room_id, session_id, confirmation_id, approved,
                )
                return "ok", result["status"]
            except Exception as error:
                return "error", getattr(error, "code", "unknown")

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(decide, [True, False]))
        winners = [result for result in results if result[0] == "ok"]
        self.assertEqual(len(winners), 1)
        self.assertIn(winners[0][1], {"approved", "rejected"})
        expected_side_effects = 1 if winners[0][1] == "approved" else 0
        self.assertEqual(self.service.repository.fetchone(
            "SELECT COUNT(*) AS value FROM selected_solutions WHERE risk_id=?", (risk_id,),
        )["value"], expected_side_effects)

        self.service.repository.execute(
            "UPDATE advisor_confirmations SET status='processing',decided_at=NULL WHERE id=?",
            (confirmation_id,),
        )
        self.service.advisor.recover_interrupted_confirmations()
        recovered = self.service.repository.fetchone(
            "SELECT status FROM advisor_confirmations WHERE id=?", (confirmation_id,),
        )
        self.assertEqual(recovered["status"], "failed")

    def test_advisor_rtc_queue_caps_at_eight_and_promotes_fifo(self) -> None:
        entries: list[dict[str, str]] = []
        with patch("backend.app.advisor.VolcengineVoiceProvider.configured", return_value=True):
            for _ in range(9):
                assessment_id, token = self.create_assessment()
                auth = self.auth(token)
                room_id = self.client.post(
                    f"/api/v2/assessments/{assessment_id}/rooms",
                    headers=auth, json={"room_type": "bathroom"},
                ).json()["room_id"]
                session_id = self.client.post(
                    f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions",
                    headers=auth, json={},
                ).json()["session_id"]
                client_id = str(uuid.uuid4())
                queued = self.client.post(
                    f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/rtc-queue",
                    headers=auth,
                    json={"client_instance_id": client_id, "mode": "audio"},
                )
                self.assertEqual(queued.status_code, 201)
                entries.append({
                    "assessment_id": assessment_id, "token": token, "room_id": room_id,
                    "session_id": session_id, "client_id": client_id,
                    "ticket_id": queued.json()["ticket_id"], "status": queued.json()["status"],
                })

            self.assertTrue(all(item["status"] == "granted" for item in entries[:8]))
            self.assertEqual(entries[8]["status"], "queued")
            self.assertEqual(
                self.service.repository.fetchone(
                    "SELECT COUNT(*) AS value FROM advisor_rtc_queue "
                    "WHERE status IN ('granted','active','draining')",
                )["value"],
                8,
            )

            bypass = self.client.post(
                f"/api/v2/assessments/{entries[0]['assessment_id']}/rooms/{entries[0]['room_id']}"
                f"/advisor/sessions/{entries[0]['session_id']}/voice",
                headers=self.auth(entries[0]["token"]),
            )
            self.assertEqual(bypass.status_code, 409)
            self.assertEqual(bypass.json()["code"], "advisor_queue_required")

            first = entries[0]
            with patch(
                "backend.app.advisor.AdvisorService._ensure_rtc",
                return_value={"available": True, "provider": "volcengine"},
            ):
                activated = self.client.post(
                    f"/api/v2/assessments/{first['assessment_id']}/rooms/{first['room_id']}"
                    f"/advisor/sessions/{first['session_id']}/voice",
                    headers={
                        **self.auth(first["token"]),
                        "X-Advisor-Client-ID": first["client_id"],
                        "X-Advisor-Queue-Ticket": first["ticket_id"],
                    },
                )
            self.assertEqual(activated.status_code, 200)
            self.assertEqual(
                self.service.repository.fetchone(
                    "SELECT status FROM advisor_rtc_queue WHERE id=?", (first["ticket_id"],),
                )["status"],
                "active",
            )
            cancelled = self.client.delete(
                f"/api/v2/assessments/{first['assessment_id']}/rooms/{first['room_id']}"
                f"/advisor/sessions/{first['session_id']}/rtc-queue/{first['ticket_id']}",
                headers={**self.auth(first["token"]), "X-Advisor-Client-ID": first["client_id"]},
            )
            self.assertEqual(cancelled.status_code, 204)
            ninth = entries[8]
            promoted = self.client.get(
                f"/api/v2/assessments/{ninth['assessment_id']}/rooms/{ninth['room_id']}"
                f"/advisor/sessions/{ninth['session_id']}/rtc-queue/{ninth['ticket_id']}",
                headers={**self.auth(ninth["token"]), "X-Advisor-Client-ID": ninth["client_id"]},
            )
            self.assertEqual(promoted.status_code, 200)
            self.assertEqual(promoted.json()["status"], "granted")

            other_client = str(uuid.uuid4())
            in_use = self.client.post(
                f"/api/v2/assessments/{ninth['assessment_id']}/rooms/{ninth['room_id']}"
                f"/advisor/sessions/{ninth['session_id']}/rtc-queue",
                headers=self.auth(ninth["token"]),
                json={"client_instance_id": other_client, "mode": "audio"},
            )
            self.assertEqual(in_use.status_code, 409)
            self.assertEqual(in_use.json()["code"], "advisor_room_in_use")

            with patch(
                "backend.app.advisor.AdvisorService._ensure_rtc",
                return_value={"available": True, "provider": "volcengine"},
            ):
                activated_ninth = self.client.post(
                    f"/api/v2/assessments/{ninth['assessment_id']}/rooms/{ninth['room_id']}"
                    f"/advisor/sessions/{ninth['session_id']}/voice",
                    headers={
                        **self.auth(ninth["token"]),
                        "X-Advisor-Client-ID": ninth["client_id"],
                        "X-Advisor-Queue-Ticket": ninth["ticket_id"],
                    },
                )
            self.assertEqual(activated_ninth.status_code, 200)
            self.service.repository.execute(
                "UPDATE advisor_rtc_queue SET lease_expires_at=? WHERE id=?",
                ("2000-01-01T00:00:00+00:00", ninth["ticket_id"]),
            )
            self.service.repository.execute(
                "UPDATE advisor_sessions SET device_lease_expires_at=? WHERE id=?",
                ("2000-01-01T00:00:00+00:00", ninth["session_id"]),
            )
            with patch("backend.app.advisor.AdvisorService._stop_provider_task", return_value=True):
                takeover = self.client.post(
                    f"/api/v2/assessments/{ninth['assessment_id']}/rooms/{ninth['room_id']}"
                    f"/advisor/sessions/{ninth['session_id']}/rtc-queue",
                    headers=self.auth(ninth["token"]),
                    json={"client_instance_id": other_client, "mode": "audio"},
                )
            self.assertEqual(takeover.status_code, 201)
            self.assertEqual(takeover.json()["status"], "granted")

            draining = entries[1]
            with patch(
                "backend.app.advisor.AdvisorService._ensure_rtc",
                return_value={"available": True, "provider": "volcengine"},
            ):
                self.client.post(
                    f"/api/v2/assessments/{draining['assessment_id']}/rooms/{draining['room_id']}"
                    f"/advisor/sessions/{draining['session_id']}/voice",
                    headers={
                        **self.auth(draining["token"]),
                        "X-Advisor-Client-ID": draining["client_id"],
                        "X-Advisor-Queue-Ticket": draining["ticket_id"],
                    },
                )
            with patch("backend.app.advisor.AdvisorService._stop_provider_task", return_value=False):
                self.client.delete(
                    f"/api/v2/assessments/{draining['assessment_id']}/rooms/{draining['room_id']}"
                    f"/advisor/sessions/{draining['session_id']}/rtc-queue/{draining['ticket_id']}",
                    headers={
                        **self.auth(draining["token"]),
                        "X-Advisor-Client-ID": draining["client_id"],
                    },
                )
            self.assertEqual(
                self.service.repository.fetchone(
                    "SELECT status FROM advisor_rtc_queue WHERE id=?", (draining["ticket_id"],),
                )["status"],
                "draining",
            )
            self.assertEqual(
                self.service.repository.fetchone(
                    "SELECT COUNT(*) AS value FROM advisor_rtc_queue "
                    "WHERE status IN ('granted','active','draining')",
                )["value"],
                8,
            )

            self.service.repository.execute(
                "UPDATE advisor_sessions SET expires_at=? WHERE id=?",
                ("2000-01-01T00:00:00+00:00", draining["session_id"]),
            )
            replacement_session = self.client.post(
                f"/api/v2/assessments/{draining['assessment_id']}/rooms/{draining['room_id']}"
                "/advisor/sessions",
                headers=self.auth(draining["token"]), json={},
            ).json()["session_id"]
            replacement_client = str(uuid.uuid4())
            cross_session_in_use = self.client.post(
                f"/api/v2/assessments/{draining['assessment_id']}/rooms/{draining['room_id']}"
                f"/advisor/sessions/{replacement_session}/rtc-queue",
                headers=self.auth(draining["token"]),
                json={"client_instance_id": replacement_client, "mode": "audio"},
            )
            self.assertEqual(cross_session_in_use.status_code, 409)
            self.assertEqual(cross_session_in_use.json()["code"], "advisor_room_in_use")

            self.service.repository.execute(
                "UPDATE advisor_rtc_queue SET lease_expires_at=? WHERE id=?",
                ("2000-01-01T00:00:00+00:00", draining["ticket_id"]),
            )
            self.service.repository.execute(
                "UPDATE advisor_sessions SET device_lease_expires_at=? WHERE id=?",
                ("2000-01-01T00:00:00+00:00", draining["session_id"]),
            )
            after_draining_lease = self.client.post(
                f"/api/v2/assessments/{draining['assessment_id']}/rooms/{draining['room_id']}"
                f"/advisor/sessions/{replacement_session}/rtc-queue",
                headers=self.auth(draining["token"]),
                json={"client_instance_id": replacement_client, "mode": "audio"},
            )
            self.assertEqual(after_draining_lease.status_code, 201)
            self.assertEqual(after_draining_lease.json()["status"], "granted")

    def test_advisor_rtc_queue_concurrent_grants_never_exceed_eight(self) -> None:
        entries: list[tuple[str, str, str]] = []
        for _ in range(12):
            assessment_id, token = self.create_assessment()
            room_id = self.client.post(
                f"/api/v2/assessments/{assessment_id}/rooms",
                headers=self.auth(token), json={"room_type": "bathroom"},
            ).json()["room_id"]
            session_id = self.client.post(
                f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions",
                headers=self.auth(token), json={},
            ).json()["session_id"]
            entries.append((assessment_id, room_id, session_id))

        def enqueue(entry: tuple[str, str, str]) -> dict:
            assessment_id, room_id, session_id = entry
            return self.service.advisor.enqueue_rtc(
                assessment_id, room_id, session_id, str(uuid.uuid4()), "audio_video",
            )

        with patch("backend.app.advisor.VolcengineVoiceProvider.configured", return_value=True):
            with ThreadPoolExecutor(max_workers=len(entries)) as executor:
                results = list(executor.map(enqueue, entries))

        self.assertEqual(sum(result["status"] == "granted" for result in results), 8)
        self.assertEqual(sum(result["status"] == "queued" for result in results), 4)
        self.assertEqual(
            self.service.repository.fetchone(
                "SELECT COUNT(*) AS value FROM advisor_rtc_queue "
                "WHERE status IN ('granted','active','draining')",
            )["value"],
            8,
        )

    def test_advisor_session_creation_is_idempotent_under_concurrency(self) -> None:
        assessment_id, token = self.create_assessment()
        room_id = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms",
            headers=self.auth(token), json={"room_type": "bathroom"},
        ).json()["room_id"]
        workers = 8
        barrier = threading.Barrier(workers)

        def create_session(_: int) -> dict:
            barrier.wait()
            return self.service.advisor.create_session(assessment_id, room_id)

        with ThreadPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(create_session, range(workers)))

        session_ids = {item["session_id"] for item in results}
        self.assertEqual(len(session_ids), 1)
        self.assertTrue(all(item["turns"] for item in results))
        self.assertEqual(
            self.service.repository.fetchone(
                "SELECT COUNT(*) AS value FROM advisor_sessions WHERE room_id=? AND status='active'",
                (room_id,),
            )["value"],
            1,
        )
        self.assertEqual(
            self.service.repository.fetchone(
                "SELECT COUNT(*) AS value FROM advisor_turns WHERE room_id=?",
                (room_id,),
            )["value"],
            1,
        )
        self.assertEqual(
            self.service.repository.fetchone(
                "SELECT COUNT(*) AS value FROM analytics_events "
                "WHERE room_id=? AND event_name='advisor_session_started'",
                (room_id,),
            )["value"],
            1,
        )

    def test_advisor_rtc_queue_rejects_when_waiting_room_is_full(self) -> None:
        responses = []
        with patch.dict(os.environ, {
            "ANJU_ADVISOR_MAX_ACTIVE_RTC": "1",
            "ANJU_ADVISOR_MAX_QUEUED": "1",
        }), patch("backend.app.advisor.VolcengineVoiceProvider.configured", return_value=True):
            for _ in range(3):
                assessment_id, token = self.create_assessment()
                room_id = self.client.post(
                    f"/api/v2/assessments/{assessment_id}/rooms",
                    headers=self.auth(token), json={"room_type": "bathroom"},
                ).json()["room_id"]
                session_id = self.client.post(
                    f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions",
                    headers=self.auth(token), json={},
                ).json()["session_id"]
                responses.append(self.client.post(
                    f"/api/v2/assessments/{assessment_id}/rooms/{room_id}"
                    f"/advisor/sessions/{session_id}/rtc-queue",
                    headers=self.auth(token),
                    json={"client_instance_id": str(uuid.uuid4()), "mode": "audio"},
                ))

        self.assertEqual(responses[0].json()["status"], "granted")
        self.assertEqual(responses[1].json()["status"], "queued")
        self.assertEqual(responses[2].status_code, 429)
        self.assertEqual(responses[2].json()["code"], "advisor_capacity_busy")

    def test_rtc_video_inspection_callback_is_signed_scoped_and_idempotent(self) -> None:
        assessment_id, token = self.create_assessment()
        auth = self.auth(token)
        room_id = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms",
            headers=auth,
            json={"room_type": "bathroom", "name": "卫生间"},
        ).json()["room_id"]
        camera_session_id = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/camera/sessions",
            headers=auth,
        ).json()["camera_session_id"]
        session_id = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions",
            headers=auth,
            json={"camera_session_id": camera_session_id},
        ).json()["session_id"]
        prepared = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/camera/sessions/{camera_session_id}/frames:prepare-inspection",
            headers=auth,
            json={
                "frame_id": str(uuid.uuid4()),
                "captured_at_ms": int(time.time() * 1000),
                "width": 720,
                "height": 1280,
                "orientation": "up",
                "perceptual_hash": "ab12cd34",
                "quality": {"brightness": 0.58, "sharpness": 0.74, "motion": 0.08},
            },
        ).json()
        with self.service.repository.transaction() as connection:
            connection.execute(
                "UPDATE advisor_sessions SET rtc_room_id = ?, provider_task_id = ?, status = 'active' WHERE id = ?",
                ("rtc-room", "rtc-task", session_id),
            )
        tool_calls = [{
            "id": "tool-call-1",
            "function": {
                "name": "record_camera_suggestions",
                "arguments": json.dumps({
                    "inspection_id": prepared["inspection_id"],
                    "suggestions": [{
                        "risk_code": "wet_floor",
                        "title": "地面可能湿滑",
                        "region_label": "淋浴区地面",
                        "bbox": {"x": 0.1, "y": 0.45, "width": 0.7, "height": 0.4},
                        "confidence": 0.84,
                        "short_advice": "建议保持地面干燥并补拍近景",
                        "capture_guidance": "停稳镜头，拍清地面材质",
                    }],
                }),
            },
        }]
        payload = {
            "Signature": "a-secure-test-signature-value",
            "AppId": "rtc-app",
            "RoomId": "rtc-room",
            "TaskId": "rtc-task",
            "Type": "tool_calls",
            "Message": json.dumps(tool_calls),
        }
        environment = {
            "ANJU_VOLC_FC_CALLBACK_SIGNATURE": "a-secure-test-signature-value",
            "ANJU_VOLC_RTC_APP_ID": "rtc-app",
        }
        with patch.dict(os.environ, environment, clear=False), patch(
            "backend.app.advisor.VolcengineVoiceProvider.update_function_result",
            return_value={"Result": "ok"},
        ) as update:
            rejected = self.client.post(
                "/api/internal/rtc/function-calls",
                json={**payload, "Signature": "wrong"},
            )
            self.assertEqual(rejected.status_code, 401)
            accepted = self.client.post("/api/internal/rtc/function-calls", json=payload)
            self.assertEqual(accepted.status_code, 200)
            replayed = self.client.post("/api/internal/rtc/function-calls", json=payload)
            self.assertEqual(replayed.status_code, 200)
            self.assertEqual(replayed.json()["results"][0]["recorded"], 1)
            update.assert_called_once()

        with self.service.repository.transaction() as connection:
            suggestions = connection.execute(
                "SELECT suggestion_json FROM camera_suggestions WHERE camera_session_id = ?",
                (camera_session_id,),
            ).fetchall()
            calls = connection.execute(
                "SELECT schema_result, status FROM advisor_tool_calls WHERE provider_call_id = ?",
                ("tool-call-1",),
            ).fetchall()
        self.assertEqual(len(suggestions), 1)
        stored_suggestion = json.loads(suggestions[0]["suggestion_json"])
        self.assertNotIn("severity", stored_suggestion)
        self.assertEqual(stored_suggestion["region"], {
            "type": "bbox", "x": 0.1, "y": 0.45, "width": 0.7, "height": 0.4,
        })
        self.assertEqual([(row["schema_result"], row["status"]) for row in calls], [("valid", "completed")])

    def test_rtc_inspection_rejects_cross_room_and_forbidden_fields(self) -> None:
        assessment_id, token = self.create_assessment()
        auth = self.auth(token)
        room_ids = []
        camera_ids = []
        for room_type, name in (("corridor", "走廊"), ("bedroom", "卧室")):
            room_id = self.client.post(
                f"/api/v2/assessments/{assessment_id}/rooms",
                headers=auth,
                json={"room_type": room_type, "name": name},
            ).json()["room_id"]
            room_ids.append(room_id)
            camera_ids.append(self.client.post(
                f"/api/v2/assessments/{assessment_id}/rooms/{room_id}/camera/sessions",
                headers=auth,
            ).json()["camera_session_id"])
        session_id = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_ids[0]}/advisor/sessions",
            headers=auth,
            json={"camera_session_id": camera_ids[0]},
        ).json()["session_id"]
        prepared = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room_ids[1]}/camera/sessions/{camera_ids[1]}/frames:prepare-inspection",
            headers=auth,
            json={
                "frame_id": str(uuid.uuid4()), "captured_at_ms": int(time.time() * 1000),
                "width": 720, "height": 1280, "orientation": "up", "perceptual_hash": "feedbeef",
                "quality": {"brightness": 0.6, "sharpness": 0.7, "motion": 0.1},
            },
        ).json()
        session = self.service.advisor._owned_session(assessment_id, room_ids[0], session_id)
        with self.assertRaises(Exception):
            self.service.advisor._record_rtc_suggestions(session, {
                "inspection_id": prepared["inspection_id"], "suggestions": [],
            })
        with self.assertRaises(Exception):
            self.service.advisor._record_rtc_suggestions(session, {
                "inspection_id": prepared["inspection_id"], "severity": "high", "suggestions": [],
            })
        with self.service.repository.transaction() as connection:
            count = connection.execute(
                "SELECT COUNT(*) AS total FROM camera_suggestions WHERE camera_session_id IN (?, ?)",
                tuple(camera_ids),
            ).fetchone()["total"]
        self.assertEqual(count, 0)

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

    def test_room_camera_is_bound_to_owned_room_and_fair_api_is_removed(self) -> None:
        assessment_id, token = self.create_assessment()
        auth = self.auth(token)
        room = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms",
            headers=auth,
            json={"room_type": "bathroom"},
        ).json()
        inspected = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room['room_id']}/camera/frames:inspect",
            headers={
                **auth, "Content-Type": "image/jpeg", "X-Image-Width": "1280", "X-Image-Height": "720",
                "X-Camera-Context": '{"frame_id":"native-frame","source_kind":"ios_camera_frame","orientation":"up","previous_summary":[]}',
            },
            content=b"\xff\xd8\xffnative-frame",
        )
        self.assertEqual(inspected.status_code, 200)
        self.assertTrue(inspected.json()["temporary"])
        self.assertEqual(inspected.json()["prompt_version"], "anju_home_camera_discovery_v1")
        self.assertEqual(
            self.service.repository.fetchone("SELECT COUNT(*) AS value FROM risks WHERE assessment_id=?", (assessment_id,))["value"],
            0,
        )
        wrong_room = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/not-owned/camera/frames:inspect",
            headers={
                **auth, "Content-Type": "image/jpeg", "X-Image-Width": "1280", "X-Image-Height": "720",
                "X-Camera-Context": '{"frame_id":"wrong-room","source_kind":"ios_camera_frame","orientation":"up","previous_summary":[]}',
            },
            content=b"\xff\xd8\xffnative-frame",
        )
        self.assertEqual(wrong_room.status_code, 404)
        self.assertEqual(self.client.post("/api/v2/fair-scans").status_code, 404)

    def test_profile_gate_and_ios_camera_media_contract(self) -> None:
        assessment_id, token = self.create_assessment()
        auth = self.auth(token)
        room = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms", headers=auth, json={"room_type": "bedroom"},
        ).json()
        uploaded = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room['room_id']}/media",
            headers={
                **auth, "Content-Type": "image/jpeg", "X-Image-Width": "1280", "X-Image-Height": "720",
                "X-Media-Source-Kind": "ios_camera_frame", "X-Media-Source-ID": "scan-1",
                "X-Media-Frame-Index": "0", "X-Media-Captured-At-Ms": "1000", "X-Media-Orientation": "up",
            },
            content=b"\xff\xd8\xffnative-frame",
        )
        self.assertEqual(uploaded.status_code, 201)
        self.assertEqual(uploaded.json()["source_kind"], "ios_camera_frame")
        blocked = self.client.post(
            f"/api/v2/assessments/{assessment_id}/rooms/{room['room_id']}:analyze", headers=auth,
        )
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(blocked.json()["code"], "profile_incomplete")

    def test_missing_frontend_build_returns_503(self) -> None:
        root = Path(self.temp.name) / "missing-static"
        app = create_app(assessment_service=self.service, static_root=root)
        with TestClient(app) as client:
            response = client.get("/")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "frontend_not_built")


if __name__ == "__main__":
    unittest.main()
