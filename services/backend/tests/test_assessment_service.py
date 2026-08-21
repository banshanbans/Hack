from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from backend.app.assessment_service import AssessmentError, AssessmentService
from backend.app.providers import MockVisionProvider
from backend.app.repositories import SQLiteRepository


JPEG = b"\xff\xd8\xff" + b"demo-image-bytes"


class CrossFrameProvider(MockVisionProvider):
    def analyze(self, assessment_id, room_type, media, allowed_risks):
        candidates = []
        for item in media:
            candidates.append({
                "risk_code": "BATH_NO_GRAB_BAR", "media_id": item["media_id"], "title": "缺少可靠扶手",
                "evidence": "相邻视频画面中的同一淋浴位置未见可靠扶手", "confidence": .91,
                "needs_manual_check": False,
                "region": {"type": "bbox", "x": .4, "y": .2, "width": .3, "height": .4, "points": None},
            })
        return {"room_type": room_type, "scene_elements": ["floor", "shower"], "risk_candidates": candidates}, self._usage()


class BlockingAnalysisProvider(MockVisionProvider):
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def analyze(self, assessment_id, room_type, media, allowed_risks):
        self.started.set()
        if not self.release.wait(timeout=3):
            raise RuntimeError("blocking_provider_timeout")
        return super().analyze(assessment_id, room_type, media, allowed_risks)


class CrashingAnalysisProvider(MockVisionProvider):
    def analyze(self, assessment_id, room_type, media, allowed_risks):
        raise RuntimeError("internal provider detail must not escape")


class AssessmentServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.db = root / "anju.db"
        self.media = root / "media"
        self.service = AssessmentService(SQLiteRepository(self.db), self.media, provider=MockVisionProvider())
        created = self.service.create_assessment({"input_mode": "photo"})
        self.assessment_id = created["assessment_id"]
        self.token = created["access_token"]
        self.service.save_profile(self.assessment_id, {"mobility": "walker", "fall_history": "once", "living_status": "alone"})
        self.room = self.service.create_room(self.assessment_id, {"room_type": "bathroom"})

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_access_token_is_hashed_and_restart_recovers_state(self) -> None:
        self.assertTrue(self.service.repository.authorize(self.assessment_id, self.token))
        stored = self.service.repository.fetchone("SELECT token_hash FROM assessments WHERE id=?", (self.assessment_id,))
        self.assertNotEqual(stored["token_hash"], self.token)
        restarted = AssessmentService(SQLiteRepository(self.db), self.media, provider=MockVisionProvider())
        self.assertEqual(restarted.assessment(self.assessment_id)["profile"]["mobility"], "walker")

    def test_restart_recovers_job_room_and_assessment_atomically(self) -> None:
        now = "2026-08-06T00:00:00+00:00"
        self.service.repository.insert("jobs", {
            "id": "orphan-job", "assessment_id": self.assessment_id, "room_id": self.room["room_id"],
            "status": "running", "stage": "risks_detecting", "error": None,
            "created_at": now, "updated_at": now,
        })
        self.service.repository.execute("UPDATE rooms SET status='analyzing' WHERE id=?", (self.room["room_id"],))
        self.service.repository.execute("UPDATE assessments SET status='analyzing' WHERE id=?", (self.assessment_id,))

        restarted = AssessmentService(SQLiteRepository(self.db), self.media, provider=MockVisionProvider())

        job = restarted.repository.fetchone("SELECT status,stage,error FROM jobs WHERE id='orphan-job'")
        room = restarted.repository.fetchone("SELECT status FROM rooms WHERE id=?", (self.room["room_id"],))
        assessment = restarted.repository.fetchone("SELECT status FROM assessments WHERE id=?", (self.assessment_id,))
        self.assertEqual(job, {"status": "failed", "stage": "interrupted", "error": "analysis_interrupted"})
        self.assertEqual(room["status"], "analysis_failed")
        self.assertEqual(assessment["status"], "in_progress")

    def test_start_analysis_reuses_the_active_room_job(self) -> None:
        provider = BlockingAnalysisProvider()
        service = AssessmentService(SQLiteRepository(self.db), self.media, provider=provider)
        service.upload_media(self.assessment_id, self.room["room_id"], JPEG, "image/jpeg", 1200, 900)

        first = service.start_analysis(self.assessment_id, self.room["room_id"])
        self.assertTrue(provider.started.wait(timeout=1))
        second = service.start_analysis(self.assessment_id, self.room["room_id"])

        self.assertFalse(first["reused"])
        self.assertTrue(second["reused"])
        self.assertEqual(second["job_id"], first["job_id"])
        count = service.repository.fetchone(
            "SELECT COUNT(*) AS value FROM jobs WHERE room_id=? AND status IN ('queued','running')",
            (self.room["room_id"],),
        )
        self.assertEqual(count["value"], 1)
        provider.release.set()
        deadline = time.time() + 3
        while time.time() < deadline:
            status = service.analysis_status(self.assessment_id, self.room["room_id"])
            if status["status"] in {"completed", "failed"}:
                break
            time.sleep(.02)
        self.assertEqual(status["status"], "completed")

    def test_unknown_worker_error_is_safely_failed_and_retryable(self) -> None:
        service = AssessmentService(SQLiteRepository(self.db), self.media, provider=CrashingAnalysisProvider())
        service.upload_media(self.assessment_id, self.room["room_id"], JPEG, "image/jpeg", 1200, 900)
        started = service.start_analysis(self.assessment_id, self.room["room_id"])
        deadline = time.time() + 3
        while time.time() < deadline:
            status = service.analysis_status(self.assessment_id, self.room["room_id"])
            if status["status"] in {"completed", "failed"}:
                break
            time.sleep(.02)

        room = service.repository.fetchone("SELECT status FROM rooms WHERE id=?", (self.room["room_id"],))
        assessment = service.repository.fetchone("SELECT status FROM assessments WHERE id=?", (self.assessment_id,))
        self.assertEqual(status["job_id"], started["job_id"])
        self.assertEqual(status["status"], "failed")
        self.assertEqual(status["error"], "analysis_failed")
        self.assertNotIn("internal provider detail", status["error"])
        self.assertEqual(room["status"], "analysis_failed")
        self.assertEqual(assessment["status"], "in_progress")

    def test_upload_analyze_feedback_solution_report_and_delete(self) -> None:
        uploaded = self.service.upload_media(self.assessment_id, self.room["room_id"], JPEG, "image/jpeg", 1200, 900)
        self.assertTrue(uploaded["quality"]["usable"])
        self.service.start_analysis(self.assessment_id, self.room["room_id"])
        deadline = time.time() + 3
        while time.time() < deadline:
            status = self.service.analysis_status(self.assessment_id, self.room["room_id"])
            if status["status"] in {"completed", "failed"}:
                break
            time.sleep(0.02)
        self.assertEqual(status["status"], "completed")
        result = self.service.room_result(self.assessment_id, self.room["room_id"])
        self.assertGreater(len(result["risks"]), 0)
        risk = result["risks"][0]
        before = result["score"]
        feedback = self.service.feedback(self.assessment_id, risk["risk_id"], {"feedback": "not_a_risk"})
        self.assertGreaterEqual(feedback["score"], before)
        solutions = self.service.risk_solutions(self.assessment_id, risk["risk_id"])["solutions"]
        self.assertEqual([item["tier"] for item in solutions], ["A", "B", "C"])
        report = self.service.select_solution(self.assessment_id, risk["risk_id"], solutions[1]["solution_package_id"])
        self.assertEqual(len(report["selected_items"]), 1)
        self.assertGreater(report["budget"]["total_max"], 0)
        recommendation = next(item for item in report["recommendations"] if item["risk_id"] == risk["risk_id"])
        self.assertEqual(recommendation["selected_solution_package_id"], solutions[1]["solution_package_id"])
        self.assertEqual([item["tier"] for item in recommendation["solutions"]], ["A", "B", "C"])

        # Re-analysis must not invalidate a risk URL or discard user work when
        # the same risk is found on the same media again.
        self.service.start_analysis(self.assessment_id, self.room["room_id"])
        deadline = time.time() + 3
        while time.time() < deadline:
            status = self.service.analysis_status(self.assessment_id, self.room["room_id"])
            if status["status"] in {"completed", "failed"}:
                break
            time.sleep(0.02)
        self.assertEqual(status["status"], "completed")
        refreshed = self.service.room_result(self.assessment_id, self.room["room_id"])
        refreshed_risk = next(item for item in refreshed["risks"] if item["risk_code"] == risk["risk_code"] and item["media_id"] == risk["media_id"])
        self.assertEqual(refreshed_risk["risk_id"], risk["risk_id"])
        self.assertEqual(refreshed_risk["state"], "rejected")
        stable_solutions = self.service.risk_solutions(self.assessment_id, risk["risk_id"])
        self.assertEqual(stable_solutions["selected_solution_package_id"], solutions[1]["solution_package_id"])

        media_path = self.media / self.assessment_id
        self.assertTrue(media_path.exists())
        self.service.delete_assessment(self.assessment_id)
        self.assertFalse(media_path.exists())

    def test_shared_report_expires(self) -> None:
        share = self.service.create_share(self.assessment_id)
        self.assertEqual(self.service.shared_report(share["token"])["checked_room_count"], 0)

    def test_planned_rooms_quality_copy_and_report_recommendations(self) -> None:
        saved = self.service.save_planned_rooms(self.assessment_id, ["bathroom", "bedroom"])
        self.assertEqual(saved["planned_rooms"], ["bathroom", "bedroom"])
        self.assertEqual(self.service.assessment(self.assessment_id)["planned_rooms"], ["bathroom", "bedroom"])

        quality = self.service._validate_quality({
            "usable": False, "clear": True, "floor_visible": True, "path_visible": False,
            "lighting_sufficient": True, "major_occlusion": False,
            "scene_elements": ["floor", "bed"], "missing_element_ids": ["toilet", "bed"],
        }, "bathroom")
        self.assertEqual(quality["scene_elements"], ["floor"])
        self.assertEqual(quality["missing_element_ids"], ["toilet"])
        self.assertEqual(quality["missing_views"], ["马桶区"])

        self.service.upload_media(self.assessment_id, self.room["room_id"], JPEG, "image/jpeg", 1200, 900)
        self.service.start_analysis(self.assessment_id, self.room["room_id"])
        deadline = time.time() + 3
        while time.time() < deadline:
            status = self.service.analysis_status(self.assessment_id, self.room["room_id"])
            if status["status"] in {"completed", "failed"}:
                break
            time.sleep(0.02)
        report = self.service.report(self.assessment_id)
        self.assertEqual(report["planned_room_count"], 2)
        self.assertTrue(report["recommendations"])
        self.assertEqual([item["tier"] for item in report["recommendations"][0]["solutions"]], ["A", "B", "C"])
        self.assertIsNone(report["recommendations"][0]["selected_solution_package_id"])

    def test_every_room_has_coverage_risks_and_solutions(self) -> None:
        for room_type in ("bedroom", "living_room", "kitchen", "corridor", "balcony"):
            with self.subTest(room_type=room_type):
                room = self.service.create_room(self.assessment_id, {"room_type": room_type})
                self.assertTrue(room["supported"])
                uploaded = self.service.upload_media(self.assessment_id, room["room_id"], JPEG, "image/jpeg", 1200, 900)
                self.assertTrue(uploaded["quality"]["scene_elements"])
                self.service.start_analysis(self.assessment_id, room["room_id"])
                deadline = time.time() + 3
                while time.time() < deadline:
                    status = self.service.analysis_status(self.assessment_id, room["room_id"])
                    if status["status"] in {"completed", "failed"}:
                        break
                    time.sleep(0.02)
                self.assertEqual(status["status"], "completed")
                result = self.service.room_result(self.assessment_id, room["room_id"])
                self.assertGreater(result["coverage"]["percent"], 0)
                self.assertGreater(len(result["risks"]), 0)
                for risk in result["risks"]:
                    solutions = self.service.risk_solutions(self.assessment_id, risk["risk_id"])["solutions"]
                    self.assertEqual([item["tier"] for item in solutions], ["A", "B", "C"])

    def test_adjacent_video_evidence_is_merged_before_scoring(self) -> None:
        service = AssessmentService(SQLiteRepository(self.db), self.media, provider=CrossFrameProvider())
        for index, captured_at in enumerate((1_000, 3_000)):
            service.upload_media(
                self.assessment_id, self.room["room_id"], JPEG + bytes([index]), "image/jpeg", 1200, 900,
                {"source_kind": "video_frame", "source_id": "video-source", "frame_index": index, "captured_at_ms": captured_at, "orientation": "up", "perceptual_hash": f"hash-{index}"},
            )
        service.start_analysis(self.assessment_id, self.room["room_id"])
        deadline = time.time() + 3
        while time.time() < deadline:
            status = service.analysis_status(self.assessment_id, self.room["room_id"])
            if status["status"] in {"completed", "failed"}:
                break
            time.sleep(.02)
        self.assertEqual(status["status"], "completed")
        risks = service.room_result(self.assessment_id, self.room["room_id"])["risks"]
        self.assertEqual(len([item for item in risks if item["risk_code"] == "BATH_NO_GRAB_BAR"]), 1)
        self.assertEqual(len(risks[0]["evidence_media_ids"]), 2)

    @patch.dict("os.environ", {"ANJU_ENABLE_H5_CAMERA": "1", "ANJU_ENABLE_IOS_HOME_CAMERA": "1"})
    def test_room_camera_uses_server_room_type_and_keeps_suggestions_temporary(self) -> None:
        class CapturingProvider(MockVisionProvider):
            room_type = None

            def inspect_camera(self, assessment_id, room_type, media, camera_rules, profile_summary, previous_summary):
                self.room_type = room_type
                return super().inspect_camera(
                    assessment_id, room_type, media, camera_rules, profile_summary, previous_summary,
                )

        provider = CapturingProvider()
        service = AssessmentService(SQLiteRepository(self.db), self.media, provider=provider)
        result = service.inspect_room_camera_frame(
            self.assessment_id, self.room["room_id"], JPEG, "image/jpeg", 1280, 720,
            {"frame_id": "ios-frame", "source_kind": "ios_camera_frame", "orientation": "up", "previous_summary": []},
        )
        self.assertEqual(provider.room_type, "bathroom")
        self.assertTrue(result["temporary"])
        self.assertEqual(result["prompt_version"], "anju_home_camera_discovery_v1")
        self.assertEqual(
            service.repository.fetchone("SELECT COUNT(*) AS value FROM risks")["value"], 0,
        )
        self.assertEqual(
            service.repository.fetchone("SELECT COUNT(*) AS value FROM media")["value"], 0,
        )

    @patch.dict("os.environ", {"ANJU_ENABLE_H5_CAMERA": "1"})
    def test_camera_suggestion_removes_unverified_measurement_values(self) -> None:
        class MeasurementProvider(MockVisionProvider):
            def inspect_camera(self, assessment_id, room_type, media, camera_rules, profile_summary, previous_summary):
                result, usage = super().inspect_camera(
                    assessment_id, room_type, media, camera_rules, profile_summary, previous_summary,
                )
                result["suggestions"][0]["evidence"] = "画面中仅 45 lux，门槛约 4cm"
                return result, usage

        service = AssessmentService(SQLiteRepository(self.db), self.media, provider=MeasurementProvider())
        result = service.inspect_room_camera_frame(
            self.assessment_id, self.room["room_id"], JPEG, "image/jpeg", 1280, 720,
            {"frame_id": "h5-frame", "source_kind": "h5_camera_frame", "orientation": "up", "previous_summary": []},
        )
        evidence = result["suggestions"][0]["evidence"]
        self.assertNotIn("45", evidence)
        self.assertNotIn("4cm", evidence)
        self.assertIn("照度需现场测量", evidence)
        self.assertIn("尺寸需现场测量", evidence)

    def test_formal_analysis_requires_complete_profile(self) -> None:
        created = self.service.create_assessment({"input_mode": "photo"})
        room = self.service.create_room(created["assessment_id"], {"room_type": "bedroom"})
        self.service.upload_media(created["assessment_id"], room["room_id"], JPEG, "image/jpeg", 1280, 720)
        with self.assertRaises(AssessmentError) as raised:
            self.service.start_analysis(created["assessment_id"], room["room_id"])
        self.assertEqual(raised.exception.code, "profile_incomplete")
        self.assertEqual(raised.exception.status, 409)

    def test_ios_camera_frame_is_accepted_by_formal_home_analysis(self) -> None:
        uploaded = self.service.upload_media(
            self.assessment_id, self.room["room_id"], JPEG, "image/jpeg", 1280, 720,
            {
                "source_kind": "ios_camera_frame", "source_id": "scan-1", "frame_index": 0,
                "captured_at_ms": 1_000, "orientation": "up",
            },
        )
        self.assertEqual(uploaded["source_kind"], "ios_camera_frame")
        started = self.service.start_analysis(self.assessment_id, self.room["room_id"])
        deadline = time.time() + 3
        while time.time() < deadline:
            status = self.service.analysis_status(self.assessment_id, self.room["room_id"])
            if status["status"] in {"completed", "failed"}:
                break
            time.sleep(.02)
        self.assertEqual(status["job_id"], started["job_id"])
        self.assertEqual(status["status"], "completed")

    def test_h5_live_camera_rules_cover_fixture_targets_without_venue_scoring(self) -> None:
        rules = {item["risk_code"]: item for item in self.service.rules.live_camera_rules_for("h5_home")}
        self.assertEqual(self.service.rules.live_camera_rule_version, "live-camera-rules-2026-07-26-v3")
        self.assertIn("豆包", rules["floor_clutter"]["visual_cue"])
        self.assertIn("椅子", rules["floor_clutter"]["visual_cue"])
        self.assertIn("插排", rules["cable_crossing"]["visual_cue"])
        self.assertIn("完全封闭的线槽", rules["cable_crossing"]["visual_cue"])
        self.assertIn("舞台", rules["level_change"]["visual_cue"])
        self.assertIn("电缆保护槽", rules["level_change"]["visual_cue"])
        self.assertNotIn("deduction", rules["level_change"])

if __name__ == "__main__":
    unittest.main()
