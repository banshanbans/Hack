#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parent.parent
SWIFT_FILES = [
    ROOT / "RASSAR App/AnjuGuard/ProductCopy.swift",
    ROOT / "RASSAR App/AnjuGuard/IssueDetailViewController.swift",
    ROOT / "RASSAR App/AnjuGuard/ReportViewController.swift",
    ROOT / "RASSAR App/UI/OnboardViewController.swift",
    ROOT / "RASSAR App/UI/ViewController.swift",
]
OTHER_FILES = [
    ROOT / "RASSAR App/Base.lproj/Main.storyboard",
    ROOT / "frontend/index.html",
    ROOT / "frontend/src/content.ts",
    ROOT / "frontend/src/App.tsx",
]
BRAND_FILES = [
    ROOT / "README.md",
    ROOT / "docs/IMPLEMENTATION_STATUS.md",
    ROOT / "competition-submission/项目介绍.md",
    ROOT / "competition-submission/skills/anju-home-safety-assessment/SKILL.md",
    ROOT / "competition-submission/skills/anju-home-safety-assessment/agents/openai.yaml",
    ROOT / "competition-submission/skills/anju-home-safety-assessment/scripts/anju_skill.py",
    ROOT / "competition-submission/packages/anju-home-safety-assessment/SKILL.md",
    ROOT / "competition-submission/packages/anju-home-safety-assessment/agents/openai.yaml",
    ROOT / "competition-submission/packages/anju-home-safety-assessment/scripts/anju_skill.py",
    ROOT / "frontend/index.html",
    ROOT / "frontend/src/content.ts",
    ROOT / "hero-demo/README.md",
    ROOT / "hero-demo/index.html",
    ROOT / "hero-demo/STORYBOARD.md",
    ROOT / "hero-demo/src/hero.config.ts",
    ROOT / "hero-demo/src/main.ts",
    ROOT / "hero-demo/src/screenSource.ts",
    ROOT / "backend/app/providers/voice.py",
    ROOT / "RASSAR App/AnjuGuard/ProductCopy.swift",
    ROOT / "RASSAR App/UI/OnboardViewController.swift",
    ROOT / "RASSAR App/Base.lproj/Main.storyboard",
    ROOT / "RASSAR App/Base.lproj/LaunchScreen.storyboard",
]
LEGACY_PRODUCT_NAMES = ["安心家 AI", "安心家AI", "安居守护", "老者 LAOZHE"]
BANNED = [
    "GPT", "Gemini", "Qwen", "豆包", "YOLO", "API", "JSON", "bbox", "置信度",
    "RoomPlan", "ARKit", "系统检测到", "上传数据进行分析", "功能介绍", "本系统将",
    "点击此处", "操作成功", "发生未知错误",
]


def swift_strings(path: Path) -> list[str]:
    content = path.read_text(encoding="utf-8")
    return [bytes(value, "utf-8").decode("unicode_escape") if "\\u" in value else value
            for value in re.findall(r'"((?:\\.|[^"\\])*)"', content)]


def main() -> int:
    failures: list[str] = []
    for path in BRAND_FILES:
        content = path.read_text(encoding="utf-8")
        for term in LEGACY_PRODUCT_NAMES:
            if term in content:
                failures.append(f"{path.relative_to(ROOT)}: legacy product name contains {term!r}")
    content_copy = (ROOT / "frontend/src/content.ts").read_text(encoding="utf-8")
    if "export const PRODUCT_NAME = '长者友好家'" not in content_copy or "brand: '长者友好家'" not in content_copy:
        failures.append("frontend/src/content.ts: canonical product name is not 长者友好家")
    swift_copy = (ROOT / "RASSAR App/AnjuGuard/ProductCopy.swift").read_text(encoding="utf-8")
    if 'static let appName = "长者友好家"' not in swift_copy:
        failures.append("RASSAR App/AnjuGuard/ProductCopy.swift: canonical product name is not 长者友好家")
    hero_copy = (ROOT / "hero-demo/src/hero.config.ts").read_text(encoding="utf-8")
    if "brand: '长者友好家'" not in hero_copy:
        failures.append("hero-demo/src/hero.config.ts: canonical product name is not 长者友好家")
    for path in SWIFT_FILES:
        for value in swift_strings(path):
            for term in BANNED:
                if term in value:
                    failures.append(f"{path.relative_to(ROOT)}: user-facing string contains {term!r}")
    for path in OTHER_FILES:
        content = path.read_text(encoding="utf-8")
        if path.suffix == ".html":
            content = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", content, flags=re.DOTALL | re.IGNORECASE)
        for term in BANNED:
            if term in content:
                failures.append(f"{path.relative_to(ROOT)}: content contains {term!r}")

    rules_path = ROOT / "RASSAR App/Resources/SafetyRules.zh-CN.json"
    rules = json.loads(rules_path.read_text(encoding="utf-8"))
    for rule in rules:
        if len(rule["title"]) > 18:
            failures.append(f"{rule['id']}: title exceeds 18 characters")
        if len(rule["primary_action"]) > 36:
            failures.append(f"{rule['id']}: primary action exceeds 36 characters")
        if rule["type"] not in {
            "loose_rug", "floor_clutter", "cable_crossing", "narrow_path", "missing_grab_bar",
            "sharp_corner", "low_lighting", "unstable_support", "high_reach_item", "bedside_obstruction",
        }:
            failures.append(f"{rule['id']}: unsupported issue type")

    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"Product copy check passed ({len(rules)} safety rules).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
