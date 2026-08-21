from datetime import timedelta
import unittest

from backend.app.service import SessionService, demo_analysis, empty_analysis


class SessionServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = SessionService()
        self.session = self.service.create_session({"room_type": "bedroom", "profiles": ["older_adult"]})

    def test_empty_provider_returns_no_issues(self) -> None:
        self.assertEqual(empty_analysis("frame-1"), {"frame_id": "frame-1", "issues": []})

    def test_unknown_type_and_invalid_bbox_are_rejected(self) -> None:
        issues = [
            {"type": "invented", "bbox": [0.1, 0.1, 0.8, 0.8]},
            {"type": "loose_rug", "bbox": [0.8, 0.1, 0.2, 0.8]},
        ]
        self.assertEqual(self.service.record_analysis(self.session.id, "frame-1", issues), [])

    def test_demo_issue_can_be_confirmed_and_reported(self) -> None:
        issue = self.service.record_analysis(self.session.id, "frame-1", demo_analysis("frame-1")["issues"])[0]
        updated = self.service.update_issue(self.session.id, issue["id"], "confirmed")
        report = self.service.complete(self.session.id)
        self.assertEqual(updated["state"], "confirmed")
        self.assertEqual(len(report["issues"]), 1)

    def test_dismissed_issue_is_not_in_report(self) -> None:
        issue = self.service.record_analysis(self.session.id, "frame-1", demo_analysis("frame-1")["issues"])[0]
        self.service.update_issue(self.session.id, issue["id"], "dismissed")
        self.assertEqual(self.service.complete(self.session.id)["issues"], [])

    def test_share_token_is_unpredictable_and_can_expire(self) -> None:
        token, _ = self.service.create_share(self.session.id)
        self.assertGreaterEqual(len(token), 24)
        self.assertIsNotNone(self.service.shared_report(token))
        expired, _ = self.service.create_share(self.session.id, timedelta(seconds=-1))
        self.assertIsNone(self.service.shared_report(expired))


if __name__ == "__main__":
    unittest.main()
