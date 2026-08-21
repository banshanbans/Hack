from decimal import Decimal
import unittest

from backend.app.rules import RuleStore
from backend.app.scoring import evidence_multiplier, score_risks


class ScoringV2Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.rules = RuleStore()
        self.profile = {"mobility": "walker", "fall_history": "once", "living_status": "alone"}

    def risk(self, risk_id: str, state: str = "unreviewed", confidence: float = 0.9) -> dict:
        return {"risk_id": risk_id, "risk_code": "BATH_NO_GRAB_BAR", "media_id": risk_id, "title": "缺少扶手", "state": state, "confidence": confidence}

    def test_confidence_thresholds(self) -> None:
        self.assertEqual(evidence_multiplier(0.8), Decimal("1.0"))
        self.assertEqual(evidence_multiplier(0.6), Decimal("0.7"))
        self.assertEqual(evidence_multiplier(0.59), Decimal("0"))

    def test_rejected_risk_does_not_deduct(self) -> None:
        result = score_risks([self.risk("r1", "rejected")], self.profile, self.rules.risk_rules)
        self.assertEqual(result["score"], 100)

    def test_pending_recheck_is_partial_and_stable(self) -> None:
        first = score_risks([self.risk("r1", "resolved_pending_recheck")], self.profile, self.rules.risk_rules)
        second = score_risks([self.risk("r1", "resolved_pending_recheck")], self.profile, self.rules.risk_rules)
        self.assertEqual(first, second)
        self.assertGreater(first["score"], score_risks([self.risk("r1", "confirmed")], self.profile, self.rules.risk_rules)["score"])

    def test_category_cap_is_applied(self) -> None:
        risks = [self.risk(f"r{index}", "confirmed") for index in range(5)]
        result = score_risks(risks, self.profile, self.rules.risk_rules)
        self.assertLessEqual(result["deduction_total"], 35)


if __name__ == "__main__":
    unittest.main()
