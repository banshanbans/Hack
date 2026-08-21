from __future__ import annotations

from pathlib import Path
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

from backend.app.assessment_service import AssessmentService
from backend.app.providers import MockVisionProvider, ProviderError
from backend.app.repositories import SQLiteRepository


class BlockingTurboProvider(MockVisionProvider):
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.two_started = threading.Event()
        self.release = threading.Event()

    def _wait(self) -> None:
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            if self.active == 2:
                self.two_started.set()
        try:
            if not self.release.wait(3):
                raise RuntimeError("test provider release timed out")
        finally:
            with self.lock:
                self.active -= 1

    def inspect_camera(self, assessment_id, room_type, media, camera_rules, profile_summary, previous_summary):
        self._wait()
        return super().inspect_camera(assessment_id, room_type, media, camera_rules, profile_summary, previous_summary)

class ModelConcurrencyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.flags = patch.dict(os.environ, {
            "ANJU_ENABLE_H5_CAMERA": "1", "ANJU_ENABLE_IOS_HOME_CAMERA": "1",
            "ANJU_TURBO_MAX_CONCURRENCY": "2", "ANJU_PRO_MAX_CONCURRENCY": "1",
        })
        self.flags.start()
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.provider = BlockingTurboProvider()
        self.service = AssessmentService(SQLiteRepository(root / "api.db"), root / "media", provider=self.provider)

    def tearDown(self) -> None:
        self.provider.release.set()
        self.service.close()
        self.temp.cleanup()
        self.flags.stop()

    def test_h5_uses_two_turbo_slots_and_rejects_the_third(self) -> None:
        first = self.service.create_assessment({})["assessment_id"]
        second = self.service.create_assessment({})["assessment_id"]
        third = self.service.create_assessment({})["assessment_id"]
        failures: list[BaseException] = []

        def h5_call() -> None:
            try:
                self.service.inspect_camera_frame(
                    first, b"\xff\xd8\xffh5", "image/jpeg", 640, 480,
                    {"frame_id": "h5-first", "room_type": "living_room", "previous_summary": []},
                )
            except BaseException as error:  # pragma: no cover - asserted through failures
                failures.append(error)

        def second_h5_call() -> None:
            try:
                self.service.inspect_camera_frame(
                    second, b"\xff\xd8\xffh5-second", "image/jpeg", 640, 480,
                    {"frame_id": "h5-second", "room_type": "corridor", "previous_summary": []},
                )
            except BaseException as error:  # pragma: no cover - asserted through failures
                failures.append(error)

        threads = [threading.Thread(target=h5_call), threading.Thread(target=second_h5_call)]
        for thread in threads:
            thread.start()
        self.assertTrue(self.provider.two_started.wait(2), "two Turbo calls did not start")

        with self.assertRaises(ProviderError) as raised:
            self.service.inspect_camera_frame(
                third, b"\xff\xd8\xffthird", "image/jpeg", 640, 480,
                {"frame_id": "h5-third", "room_type": "bathroom", "previous_summary": []},
            )
        self.assertEqual(raised.exception.code, "provider_capacity_busy")
        rejected = self.service.repository.fetchone(
            "SELECT payload_json FROM analytics_events WHERE assessment_id=? AND event_name='ai_call_rejected'",
            (third,),
        )
        self.assertIsNotNone(rejected)

        self.provider.release.set()
        for thread in threads:
            thread.join(3)
        self.assertFalse(failures)
        self.assertEqual(self.provider.max_active, 2)

    def test_pro_slot_queues_and_runs_only_one_block_at_a_time(self) -> None:
        first_entered = threading.Event()
        second_attempting = threading.Event()
        second_entered = threading.Event()
        release_first = threading.Event()
        active = 0
        max_active = 0
        lock = threading.Lock()

        def worker(name: str) -> None:
            nonlocal active, max_active
            if name == "second":
                second_attempting.set()
            with self.service._model_slot("pro", name, None, "test_pro"):
                with lock:
                    active += 1
                    max_active = max(max_active, active)
                if name == "first":
                    first_entered.set()
                    release_first.wait(3)
                else:
                    second_entered.set()
                with lock:
                    active -= 1

        first = threading.Thread(target=worker, args=("first",))
        second = threading.Thread(target=worker, args=("second",))
        first.start()
        self.assertTrue(first_entered.wait(1))
        second.start()
        self.assertTrue(second_attempting.wait(1))
        self.assertFalse(second_entered.wait(.1), "second Pro call bypassed the concurrency limit")
        release_first.set()
        self.assertTrue(second_entered.wait(1))
        first.join(2)
        second.join(2)

        self.assertEqual(max_active, 1)
        queued = self.service.repository.fetchone(
            "SELECT payload_json FROM analytics_events WHERE assessment_id='second' AND event_name='ai_call_queued'"
        )
        self.assertIsNotNone(queued)


if __name__ == "__main__":
    unittest.main()
