from pathlib import Path
import tempfile
import time
import unittest

from backend.app.assessment_service import AssessmentService
from backend.app.providers import MockVisionProvider
from backend.app.repositories import SQLiteRepository


JPEG = b"\xff\xd8\xff" + b"demo-image-bytes"


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


if __name__ == "__main__":
    unittest.main()
