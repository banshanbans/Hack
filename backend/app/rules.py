from __future__ import annotations

import json
from pathlib import Path


RULE_ROOT = Path(__file__).resolve().parent.parent / "rules"


class RuleValidationError(ValueError):
    pass


class RuleStore:
    def __init__(self, root: Path = RULE_ROOT) -> None:
        self.root = root
        self.risk_document = self._read("risk_rules.zh-CN.json")
        self.solution_document = self._read("solution_packages.zh-CN.json")
        self.price_document = self._read("price_rules.CN.json")
        self.coverage_document = self._read("room_coverage_rules.json")
        self.profile_document = self._read("profile_modifiers.json")
        self._validate()
        self.risk_rules = {item["risk_code"]: item for item in self.risk_document["rules"]}
        self.solutions = {item["solution_package_id"]: item for item in self.solution_document["solutions"]}
        self.prices = {item["price_rule_id"]: item for item in self.price_document["prices"]}

    @property
    def rule_set_version(self) -> str:
        return str(self.risk_document["version"])

    @property
    def price_rule_version(self) -> str:
        return str(self.price_document["version"])

    def solutions_for(self, risk_code: str) -> list[dict]:
        rule = self.risk_rules.get(risk_code)
        if not rule:
            return []
        result: list[dict] = []
        for solution_id in rule["solution_package_ids"]:
            solution = dict(self.solutions[solution_id])
            price = self.prices.get(solution["price_rule_id"])
            solution["price"] = dict(price) if price else None
            result.append(solution)
        return sorted(result, key=lambda item: item["tier"])

    def _read(self, name: str) -> dict:
        value = json.loads((self.root / name).read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise RuleValidationError(f"{name} must contain an object")
        return value

    def _validate(self) -> None:
        risk_codes: set[str] = set()
        solution_ids: set[str] = set()
        price_ids: set[str] = set()
        for price in self.price_document.get("prices", []):
            required = {"price_rule_id", "currency", "material_min", "material_max", "labor_min", "labor_max", "total_min", "total_max"}
            if not required.issubset(price):
                raise RuleValidationError("price rule missing required fields")
            if price["price_rule_id"] in price_ids:
                raise RuleValidationError("duplicate price rule")
            price_ids.add(price["price_rule_id"])
            for low, high in (("material_min", "material_max"), ("labor_min", "labor_max"), ("total_min", "total_max")):
                if not isinstance(price[low], int) or not isinstance(price[high], int) or price[low] < 0 or price[low] > price[high]:
                    raise RuleValidationError(f"invalid amount range in {price['price_rule_id']}")
        for solution in self.solution_document.get("solutions", []):
            required = {"solution_package_id", "risk_code", "tier", "title", "summary", "price_rule_id", "budget_group_id"}
            if not required.issubset(solution) or solution["tier"] not in {"A", "B", "C"}:
                raise RuleValidationError("invalid solution package")
            if solution["solution_package_id"] in solution_ids:
                raise RuleValidationError("duplicate solution package")
            if solution["price_rule_id"] not in price_ids:
                raise RuleValidationError("solution references unknown price")
            solution_ids.add(solution["solution_package_id"])
        for risk in self.risk_document.get("rules", []):
            required = {"risk_code", "category", "room_types", "default_severity", "base_deduction", "solution_package_ids"}
            if not required.issubset(risk) or risk["default_severity"] not in {"high", "medium", "low"}:
                raise RuleValidationError("invalid risk rule")
            if risk["risk_code"] in risk_codes:
                raise RuleValidationError("duplicate risk rule")
            if set(risk["solution_package_ids"]) - solution_ids:
                raise RuleValidationError("risk references unknown solution")
            if {self._solution_tier(item) for item in risk["solution_package_ids"]} != {"A", "B", "C"}:
                raise RuleValidationError("supported risks require A/B/C solutions")
            risk_codes.add(risk["risk_code"])

    def _solution_tier(self, solution_id: str) -> str:
        for item in self.solution_document.get("solutions", []):
            if item.get("solution_package_id") == solution_id:
                return str(item.get("tier"))
        return ""
