from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from backend.app.assessment_service import AssessmentService
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


class FairRiskProvider(MockVisionProvider):
    def __init__(self, risk_code: str) -> None:
        self.risk_code = risk_code

    def fair_analyze(self, scan_id, zone_id, media, camera_rules):
        rule = next(item for item in camera_rules if item["risk_code"] == self.risk_code)
        usage = self._usage()
        usage["prompt_version"] = "anju_ios_fair_pro_direct_v2"
        return {
            "frame_id": media["media_id"], "zone_id": zone_id,
            "candidates": [{
                "risk_code": self.risk_code,
                "evidence_codes": list(rule["required_evidence_codes"]),
                "evidence": "现场画面有清晰、可定位的受控证据",
                "confidence": .92, "needs_manual_check": False,
                "bbox": [.1, .2, .7, .8],
            }],
        }, usage


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

    @patch.dict("os.environ", {"ANJU_ENABLE_IOS_FAIR_AR": "1"})
    def test_direct_pro_findings_are_finalized_without_a_second_model_call(self) -> None:
        service = AssessmentService(SQLiteRepository(self.db), self.media, provider=FairRiskProvider("floor_clutter"))
        scan = service.create_fair_scan()
        service.analyze_fair_frame(scan["scan_id"], "entrance", "frame-direct", JPEG, "image/jpeg", 1280, 720, "right")
        reviewed = service.finalize_fair_zone(scan["scan_id"], "entrance")
        self.assertEqual(reviewed["status"], "reviewed")
        self.assertEqual(reviewed["prompt_version"], "anju_ios_fair_pro_direct_v2")
        self.assertLess(reviewed["score"], 100)
        self.assertEqual(reviewed["risks"][0]["status"], "confirmed")
        self.assertTrue(reviewed["risks"][0]["score_eligible"])
        report = service.fair_report(scan["scan_id"])
        self.assertEqual(report["status"], "reviewed")
        self.assertEqual(report["prompt_version"], "anju_ios_fair_pro_direct_v2")

    def test_venue_fair_rules_are_versioned_and_identical_for_all_zones(self) -> None:
        expected = set(self.service.rules.fair_risk_rules)
        self.assertEqual(len(expected), 12)
        self.assertEqual({"crowded_path", "marked_exit_obstruction", "low_hanging_obstruction"} - expected, set())
        for zone in ("entrance", "main_aisle", "booth", "rest_area"):
            self.assertEqual({item["risk_code"] for item in self.service.rules.fair_rules_for(zone)}, expected)
        for code in expected:
            solutions = self.service.rules.fair_solutions_for(code)
            self.assertEqual([item["tier"] for item in solutions], ["A", "B", "C"])
            self.assertEqual([(item["total_min"], item["total_max"]) for item in solutions], [(0, 80), (80, 500), (500, 3000)])

    def test_venue_fair_fixture_targets_require_visible_path_relationships(self) -> None:
        rules = self.service.rules.fair_risk_rules
        clutter = rules["floor_clutter"]
        self.assertEqual(
            set(clutter["required_evidence_codes"]),
            {"localized_obstruction_visible", "path_intrusion_visible"},
        )
        self.assertIn("豆包", clutter["visual_cue"])
        self.assertIn("椅子", clutter["visual_cue"])

        cable = rules["cable_crossing"]
        self.assertEqual(
            set(cable["required_evidence_codes"]),
            {"exposed_cable_or_power_strip_visible", "path_intrusion_visible"},
        )
        self.assertIn("插排", cable["visual_cue"])
        self.assertIn("完全封闭的线槽", cable["visual_cue"])

        level = rules["level_change"]
        self.assertEqual(
            set(level["required_evidence_codes"]),
            {"level_change_visible", "path_intrusion_visible"},
        )
        self.assertIn("舞台", level["visual_cue"])
        self.assertIn("电缆保护槽", level["visual_cue"])

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

    def test_marked_exit_candidate_with_incomplete_evidence_is_pending_and_does_not_score(self) -> None:
        rule = self.service.rules.fair_risk_rules["marked_exit_obstruction"]
        value = {
            "frame_id": "exit-frame", "zone_id": "entrance",
            "candidates": [{
                "risk_code": "marked_exit_obstruction", "evidence_codes": ["marked_exit_visible"],
                "evidence": "仅看到出口标识", "confidence": .9,
                "needs_manual_check": False, "bbox": [.1, .2, .5, .8],
            }],
        }
        candidates = self.service._validate_fair_candidates(value, "exit-frame", "entrance", {"marked_exit_obstruction": rule})
        self.assertEqual(len(candidates), 1)
        self.assertTrue(candidates[0]["needs_manual_check"])
        self.assertFalse(candidates[0]["evidence_complete"])
        reviews = [{
            "candidate_id": candidates[0]["candidate_id"], "status": "confirmed",
            "risk_code": "marked_exit_obstruction", "evidence": "仅看到出口标识",
            "bbox": candidates[0]["bbox"], "merged_into_candidate_id": None,
        }]
        risks = self.service._fair_formal_risks(reviews, candidates)
        self.assertEqual(risks[0]["status"], "manual_check")
        self.assertFalse(risks[0]["score_eligible"])

    def test_unknown_evidence_codes_are_removed_and_candidate_is_pending(self) -> None:
        rule = self.service.rules.fair_risk_rules["floor_clutter"]
        value = {
            "frame_id": "clutter-frame", "zone_id": "booth",
            "candidates": [{
                "risk_code": "floor_clutter", "evidence_codes": ["invented_code"],
                "evidence": "地面有可定位物品", "confidence": .8,
                "needs_manual_check": False, "bbox": [.1, .2, .5, .8],
            }],
        }
        candidates = self.service._validate_fair_candidates(value, "clutter-frame", "booth", {"floor_clutter": rule})
        self.assertEqual(candidates[0]["evidence_codes"], [])
        self.assertTrue(candidates[0]["needs_manual_check"])
        self.assertFalse(candidates[0]["evidence_complete"])

    @patch.dict("os.environ", {"ANJU_ENABLE_IOS_FAIR_AR": "1"})
    def test_single_frame_crowding_is_manual_and_does_not_score(self) -> None:
        service = AssessmentService(SQLiteRepository(self.db), self.media, provider=FairRiskProvider("crowded_path"))
        scan = service.create_fair_scan()
        service.analyze_fair_frame(scan["scan_id"], "main_aisle", "crowd-one", JPEG, "image/jpeg", 1280, 720, "right")
        reviewed = service.finalize_fair_zone(scan["scan_id"], "main_aisle")
        self.assertEqual(reviewed["score"], 100)
        self.assertEqual(len(reviewed["risks"]), 1)
        self.assertEqual(reviewed["risks"][0]["status"], "manual_check")
        self.assertFalse(reviewed["risks"][0]["score_eligible"])

    @patch.dict("os.environ", {"ANJU_ENABLE_IOS_FAIR_AR": "1"})
    def test_sustained_crowding_across_frames_scores_once(self) -> None:
        service = AssessmentService(SQLiteRepository(self.db), self.media, provider=FairRiskProvider("crowded_path"))
        scan = service.create_fair_scan()
        for frame_id in ("crowd-early", "crowd-late"):
            service.analyze_fair_frame(scan["scan_id"], "main_aisle", frame_id, JPEG, "image/jpeg", 1280, 720, "right")
        service.repository.execute("UPDATE fair_frames SET created_at=? WHERE id=?", ("2026-07-26T00:00:00+00:00", "crowd-early"))
        service.repository.execute("UPDATE fair_frames SET created_at=? WHERE id=?", ("2026-07-26T00:00:04+00:00", "crowd-late"))
        reviewed = service.finalize_fair_zone(scan["scan_id"], "main_aisle")
        self.assertEqual(reviewed["score"], 92)
        self.assertEqual(len(reviewed["risks"]), 1)
        self.assertTrue(reviewed["risks"][0]["score_eligible"])
        self.assertEqual(set(reviewed["risks"][0]["evidence_frame_ids"]), {"crowd-early", "crowd-late"})


if __name__ == "__main__":
    unittest.main()
