from __future__ import annotations

from pathlib import Path
import json
import os
import tempfile
import time
import unittest
from unittest.mock import patch

from backend.app.assessment_service import AssessmentError, AssessmentService
from backend.app.providers import MockRenovationProvider, MockVisionProvider
from backend.app.repositories import SQLiteRepository, utc_now


JPEG = b"\xff\xd8\xff" + b"renovation-test-image"


class CapturingRenovationProvider(MockRenovationProvider):
    def __init__(self) -> None:
        self.prompts: list[str] = []

    def edit(self, assessment_id: str, source: dict, prompt: str):
        self.prompts.append(prompt)
        return super().edit(assessment_id, source, prompt)


class FailingGroundingProvider(MockVisionProvider):
    def ground_renovation_changes(self, assessment_id: str, before_media: dict, after_media: dict, actions: list[dict]):
        raise RuntimeError("grounding unavailable")


class RenovationPreviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.flags = patch.dict(os.environ, {
            "ANJU_ENABLE_RENOVATION_PREVIEW": "1",
            "ANJU_RENOVATION_PREVIEW_DAILY_LIMIT": "3",
        })
        self.flags.start()
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.provider = CapturingRenovationProvider()
        self.service = AssessmentService(
            SQLiteRepository(root / "anju.db"), root / "media",
            provider=MockVisionProvider(), renovation_provider=self.provider,
        )
        created = self.service.create_assessment({"input_mode": "photo"})
        self.assessment_id = created["assessment_id"]
        self.service.save_profile(self.assessment_id, {"mobility": "cane", "fall_history": "once", "living_status": "alone"})
        self.room = self.service.create_room(self.assessment_id, {"room_type": "bathroom"})
        self.media = self.service.upload_media(self.assessment_id, self.room["room_id"], JPEG, "image/jpeg", 1200, 900)
        self.service.start_analysis(self.assessment_id, self.room["room_id"])
        deadline = time.time() + 3
        while time.time() < deadline:
            status = self.service.analysis_status(self.assessment_id, self.room["room_id"])
            if status["status"] in {"completed", "failed"}:
                break
            time.sleep(.02)
        self.assertEqual(status["status"], "completed")
        self.risk = self.service.room_result(self.assessment_id, self.room["room_id"])["risks"][0]
        self.solutions = self.service.risk_solutions(self.assessment_id, self.risk["risk_id"])["solutions"]

    def tearDown(self) -> None:
        self.service.close()
        self.temp.cleanup()
        self.flags.stop()

    def _wait(self, preview_id: str) -> dict:
        deadline = time.time() + 3
        while time.time() < deadline:
            value = self.service.renovation_preview(self.assessment_id, self.room["room_id"], preview_id)
            if value["status"] in {"completed", "failed"}:
                return value
            time.sleep(.02)
        self.fail("preview did not finish")

    def test_room_preview_is_generated_selected_and_staled_without_changing_score(self) -> None:
        before = self.service.room_result(self.assessment_id, self.room["room_id"])
        selected = next(item for item in self.solutions if item["tier"] == "B")
        self.service.select_solution(self.assessment_id, self.risk["risk_id"], selected["solution_package_id"])
        context = self.service.renovation_preview_context(self.assessment_id, self.room["room_id"])
        self.assertEqual(context["eligible_media"][0]["media_id"], self.media["media_id"])
        self.assertTrue(context["eligible_media"][0]["recommended"])
        self.assertTrue(context["selected_solutions"][0]["visualizable_actions"])
        self.assertNotIn("prompt", json.dumps(context, ensure_ascii=False))

        created = self.service.create_renovation_preview(self.assessment_id, self.room["room_id"], self.media["media_id"])
        completed = self._wait(created["preview_id"])
        self.assertEqual(completed["status"], "completed")
        self.assertTrue(completed["visualized_actions"][0]["region"])
        self.assertGreaterEqual(completed["visualized_actions"][0]["confidence"], .55)
        self.assertTrue(Path(self.service.renovation_preview_content(self.assessment_id, self.room["room_id"], completed["preview_id"])[0]).is_file())
        self.assertNotIn("价格", self.provider.prompts[0])
        self.assertNotIn("评分", self.provider.prompts[0])
        self.assertIn("只允许执行以下可视化动作", self.provider.prompts[0])

        chosen = self.service.select_renovation_preview(self.assessment_id, self.room["room_id"], completed["preview_id"])
        self.assertTrue(chosen["selected_for_report"])
        self.assertEqual(len(self.service.report(self.assessment_id)["renovation_previews"]), 1)
        after = self.service.room_result(self.assessment_id, self.room["room_id"])
        self.assertEqual((before["score"], before["coverage"]), (after["score"], after["coverage"]))

        replacement = next(item for item in self.solutions if item["tier"] == "C")
        self.service.select_solution(self.assessment_id, self.risk["risk_id"], replacement["solution_package_id"])
        stale = self.service.renovation_preview(self.assessment_id, self.room["room_id"], completed["preview_id"])
        self.assertTrue(stale["stale"])
        self.assertFalse(stale["selected_for_report"])
        self.assertEqual(self.service.report(self.assessment_id)["renovation_previews"], [])

    def test_grounding_failure_keeps_generated_image_without_fabricated_boxes(self) -> None:
        selected = next(item for item in self.solutions if item["tier"] == "B")
        self.service.select_solution(self.assessment_id, self.risk["risk_id"], selected["solution_package_id"])
        self.service._provider = FailingGroundingProvider()
        created = self.service.create_renovation_preview(self.assessment_id, self.room["room_id"], self.media["media_id"])
        completed = self._wait(created["preview_id"])
        self.assertEqual(completed["status"], "completed")
        self.assertTrue(completed["after_content_path"])
        self.assertTrue(all("region" not in action for action in completed["visualized_actions"]))

    def test_preview_requires_selection_and_recovers_interrupted_job(self) -> None:
        with self.assertRaises(AssessmentError) as raised:
            self.service.create_renovation_preview(self.assessment_id, self.room["room_id"], self.media["media_id"])
        self.assertEqual(raised.exception.code, "renovation_no_selected_solutions")

        now = utc_now()
        self.service.repository.insert("renovation_previews", {
            "id": "interrupted", "assessment_id": self.assessment_id, "room_id": self.room["room_id"],
            "source_media_id": self.media["media_id"], "selection_snapshot_json": "[]", "selection_hash": "old",
            "status": "running", "stage": "editing_image", "error": None, "provider": "ark", "model": "model",
            "prompt_version": "v1", "rule_set_version": self.service.rules.rule_set_version,
            "visualized_actions_json": "[]", "skipped_actions_json": "[]", "output_path": None,
            "output_mime_type": None, "selected_for_report": 0, "created_at": now, "updated_at": now,
        })
        self.service._recover_interrupted_renovation_previews()
        recovered = self.service.repository.fetchone("SELECT status,error FROM renovation_previews WHERE id='interrupted'")
        self.assertEqual(recovered, {"status": "failed", "error": "renovation_preview_interrupted"})


if __name__ == "__main__":
    unittest.main()
