from __future__ import annotations

import json
from pathlib import Path


RULE_ROOT = Path(__file__).resolve().parent.parent / "rules"
SUPPORTED_ROOM_TYPES = {"bathroom", "bedroom", "living_room", "kitchen", "corridor", "balcony"}
SUPPORTED_CAMERA_CONTEXTS = {"h5_home"}


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
        self.live_camera_document = self._read("live_camera_rules.zh-CN.json")
        self.renovation_visualization_document = self._read("renovation_visualization_rules.zh-CN.json")
        self._validate()
        self.risk_rules = {item["risk_code"]: item for item in self.risk_document["rules"]}
        visual_rules = self.renovation_visualization_document["solutions"]
        self.solutions = {
            item["solution_package_id"]: {**item, **visual_rules[item["solution_package_id"]]}
            for item in self.solution_document["solutions"]
        }
        self.prices = {item["price_rule_id"]: item for item in self.price_document["prices"]}
        self.live_camera_rules = {item["risk_code"]: item for item in self.live_camera_document["rules"]}

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
            solution = self.solution_for_output(solution_id)
            price = self.prices.get(solution["price_rule_id"])
            solution["price"] = dict(price) if price else None
            result.append(solution)
        return sorted(result, key=lambda item: item["tier"])

    def solution_for_output(self, solution_id: str) -> dict:
        solution = dict(self.solutions[solution_id])
        solution["visualizable_actions"] = [
            {"action_code": action["action_code"], "label": action["label"]}
            for action in solution.get("visualizable_actions", [])
        ]
        return solution

    @property
    def live_camera_rule_version(self) -> str:
        return str(self.live_camera_document["version"])

    def live_camera_rules_for(self, context: str, room_type: str | None = None) -> list[dict]:
        if context not in SUPPORTED_CAMERA_CONTEXTS:
            return []
        if room_type is not None and room_type not in SUPPORTED_ROOM_TYPES:
            return []
        return [
            dict(item) for item in self.live_camera_document["rules"]
            if context in item["contexts"]
            and (room_type is None or room_type in item["room_types"])
        ]

    def _read(self, name: str) -> dict:
        value = json.loads((self.root / name).read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise RuleValidationError(f"{name} must contain an object")
        return value

    def _validate(self) -> None:
        risk_codes: set[str] = set()
        solution_ids: set[str] = set()
        price_ids: set[str] = set()
        coverage_rooms = set(self.coverage_document.get("rooms", {}))
        if coverage_rooms != SUPPORTED_ROOM_TYPES or set(self.coverage_document.get("room_weights", {})) != SUPPORTED_ROOM_TYPES:
            raise RuleValidationError("coverage rules must define every supported room")
        for room_type, room in self.coverage_document["rooms"].items():
            elements = room.get("elements", [])
            if not elements or sum(item.get("weight", 0) for item in elements) != 100:
                raise RuleValidationError(f"coverage weights must total 100 for {room_type}")
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
        visual_rules = self.renovation_visualization_document.get("solutions", {})
        if set(visual_rules) != solution_ids:
            raise RuleValidationError("renovation visualization rules must define every solution")
        action_codes: set[str] = set()
        for solution_id, rule in visual_rules.items():
            actions = rule.get("visualizable_actions")
            if not isinstance(actions, list):
                raise RuleValidationError(f"invalid visualization actions for {solution_id}")
            for action in actions:
                required = {"action_code", "label", "prompt"}
                if not isinstance(action, dict) or not required.issubset(action):
                    raise RuleValidationError(f"invalid visualization action for {solution_id}")
                if any(not isinstance(action[key], str) or not action[key].strip() for key in required):
                    raise RuleValidationError(f"empty visualization action for {solution_id}")
                if action["action_code"] in action_codes:
                    raise RuleValidationError("duplicate visualization action code")
                action_codes.add(action["action_code"])
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
        covered_by_risks = {room_type for risk in self.risk_document.get("rules", []) for room_type in risk.get("room_types", [])}
        if not SUPPORTED_ROOM_TYPES.issubset(covered_by_risks):
            raise RuleValidationError("risk rules must cover every supported room")
        if set(self.live_camera_document.get("contexts", [])) != SUPPORTED_CAMERA_CONTEXTS:
            raise RuleValidationError("live camera rules must declare supported contexts")
        live_codes: set[str] = set()
        covered_camera_contexts: set[str] = set()
        for rule in self.live_camera_document.get("rules", []):
            required = {"risk_code", "contexts", "room_types", "title", "short_advice", "visual_cue"}
            contexts = set(rule.get("contexts", []))
            room_types = set(rule.get("room_types", []))
            if (
                not required.issubset(rule) or not contexts
                or not contexts.issubset(SUPPORTED_CAMERA_CONTEXTS)
                or not room_types or not room_types.issubset(SUPPORTED_ROOM_TYPES)
            ):
                raise RuleValidationError("invalid live camera rule")
            if rule["risk_code"] in live_codes:
                raise RuleValidationError("duplicate live camera rule")
            if any(not isinstance(rule[key], str) or not rule[key].strip() for key in ("risk_code", "title", "short_advice", "visual_cue")):
                raise RuleValidationError("live camera copy must be non-empty")
            live_codes.add(rule["risk_code"])
            covered_camera_contexts.update(contexts)
        if covered_camera_contexts != SUPPORTED_CAMERA_CONTEXTS:
            raise RuleValidationError("live camera rules must cover every context")

    def _solution_tier(self, solution_id: str) -> str:
        for item in self.solution_document.get("solutions", []):
            if item.get("solution_package_id") == solution_id:
                return str(item.get("tier"))
        return ""
