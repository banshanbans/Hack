from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP


USER_MULTIPLIERS = {
    "unreviewed": Decimal("0.85"),
    "confirmed": Decimal("1.00"),
    "rejected": Decimal("0"),
    "resolved_pending_recheck": Decimal("0.30"),
    "verified_resolved": Decimal("0"),
}


def evidence_multiplier(confidence: float) -> Decimal:
    if confidence >= 0.8:
        return Decimal("1.0")
    if confidence >= 0.6:
        return Decimal("0.7")
    return Decimal("0")


def profile_multiplier(profile: dict, risk_rule: dict) -> tuple[Decimal, list[str]]:
    value = Decimal("1.0")
    applied: list[str] = []
    history = profile.get("fall_history")
    if history == "once":
        value *= Decimal("1.15")
        applied.append("PROFILE_FALL_ONCE")
    elif history == "multiple":
        value *= Decimal("1.30")
        applied.append("PROFILE_FALL_MULTIPLE")
    mobility = profile.get("mobility")
    category = risk_rule.get("category")
    if mobility in {"cane", "walker"} and category in {"pathway", "support_and_transfer"}:
        value *= Decimal("1.10")
        applied.append("PROFILE_MOBILITY_SUPPORT")
    if mobility == "wheelchair" and category in {"threshold", "pathway"}:
        value *= Decimal("1.20")
        applied.append("PROFILE_WHEELCHAIR_ACCESS")
    if profile.get("living_status") == "alone" and category in {"support_and_transfer", "lighting"}:
        value *= Decimal("1.10")
        applied.append("PROFILE_LIVING_ALONE")
    return value, applied


def score_risks(risks: list[dict], profile: dict, risk_rules: dict[str, dict]) -> dict:
    category_totals: dict[str, Decimal] = {}
    breakdown: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for risk in risks:
        rule = risk_rules.get(risk.get("risk_code"))
        if not rule:
            continue
        dedupe_key = (risk.get("risk_code", ""), risk.get("media_id", ""))
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        confidence = float(risk.get("confidence", 0))
        evidence = evidence_multiplier(confidence)
        profile_value, profile_rules = profile_multiplier(profile, rule)
        user_value = USER_MULTIPLIERS.get(risk.get("state", "unreviewed"), Decimal("0.85"))
        raw = Decimal(str(rule["base_deduction"])) * profile_value * evidence * user_value
        raw = min(Decimal("18"), raw)
        category = str(rule["category"])
        remaining = max(Decimal("0"), Decimal("35") - category_totals.get(category, Decimal("0")))
        deduction = min(raw, remaining).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        category_totals[category] = category_totals.get(category, Decimal("0")) + deduction
        breakdown.append({
            "risk_id": risk["risk_id"],
            "risk_code": risk["risk_code"],
            "title": risk["title"],
            "deduction": float(deduction),
            "base_deduction": rule["base_deduction"],
            "profile_multiplier": float(profile_value),
            "exposure_multiplier": 1.0,
            "evidence_multiplier": float(evidence),
            "user_multiplier": float(user_value),
            "rule_ids": [rule["rule_id"], *profile_rules],
        })
    total = sum((Decimal(str(item["deduction"])) for item in breakdown), Decimal("0"))
    score = max(Decimal("0"), Decimal("100") - total).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return {"score": int(score), "deduction_total": float(total), "label": score_label(int(score)), "breakdown": breakdown}


def score_label(score: int) -> str:
    if score >= 85:
        return "当前已评估区域相对稳妥"
    if score >= 70:
        return "存在若干建议改善项"
    if score >= 50:
        return "存在明显安全风险"
    return "存在较多高优先级风险"


def calculate_coverage(scene_elements: list[str], coverage_rule: dict) -> dict:
    matched = set(scene_elements)
    total = sum(int(item["weight"]) for item in coverage_rule["elements"])
    achieved = sum(int(item["weight"]) for item in coverage_rule["elements"] if item["id"] in matched)
    percent = round(achieved / total * 100) if total else 0
    missing = [item["label"] for item in coverage_rule["elements"] if item["id"] not in matched]
    return {"percent": percent, "matched_elements": sorted(matched), "missing_views": missing, "limited": percent < 60}
