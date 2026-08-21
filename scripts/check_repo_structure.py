#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
AWARD_COPY = (
    "🏆 **抖音 AI 创变者计划 · 视觉搜索赛道 全国一等奖** · "
    "面向适老化居住环境的多模态 AI 安全检查与整改辅助产品"
)
EXPECTED_DIRECTORIES = (
    "apps/web",
    "apps/ios",
    "services/backend",
    "packages/AnjuCore",
    "demos/hero",
    "demos/motion",
    "competition/skills/anju-home-safety-assessment",
    "docs/assets/readme",
)
REMOVED_TOP_LEVEL = (
    "frontend",
    "backend",
    "Packages",
    "RASSAR App",
    "RASSAR App.xcodeproj",
    "RASSAR App.xcworkspace",
    "hero-demo",
    "motion-demo",
    "competition-submission",
)
FORBIDDEN_TRACKED_PARTS = (
    "/.playwright-cli/",
    "/node_modules/",
    "/dist/",
    "/out/",
    "/.DS_Store",
    "/xcuserdata/",
)
LEGACY_REFERENCE_PATTERNS = (
    re.compile(r"(?<!apps/)frontend/"),
    re.compile(r"(?<!services/)(?<!/app/)backend/"),
    re.compile(r"(?<!packages/)Packages/AnjuCore"),
    re.compile(r"Dockerfile\.production"),
    re.compile(r"competition-submission/"),
    re.compile(r"hero-demo/"),
    re.compile(r"motion-demo/"),
    re.compile(r"docs/final-round-audit/"),
    re.compile(r"docs/(?:IMPLEMENTATION_STATUS|CAMERA_UPGRADE_ROADMAP|PRODUCTION_DEPLOYMENT)\.md"),
)


def tracked_files() -> list[str]:
    output = subprocess.check_output(
        ["git", "ls-files", "-z"], cwd=ROOT
    ).decode("utf-8")
    return [item for item in output.split("\0") if item]


def local_markdown_targets(readme: str) -> set[str]:
    targets = set(re.findall(r"!?\[[^\]]*\]\(([^)]+)\)", readme))
    targets.update(re.findall(r'<img\s+[^>]*src="([^"]+)"', readme))
    return {
        target.split("#", 1)[0]
        for target in targets
        if target and not target.startswith(("http://", "https://", "mailto:", "#"))
    }


def main() -> int:
    failures: list[str] = []
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    if readme.count(AWARD_COPY) != 1:
        failures.append("README.md must contain the exact award copy once")
    if AWARD_COPY not in "\n".join(readme.splitlines()[:5]):
        failures.append("README.md award copy must appear within the first five lines")

    for relative in EXPECTED_DIRECTORIES:
        if not (ROOT / relative).is_dir():
            failures.append(f"missing expected directory: {relative}")
    top_level_names = {path.name for path in ROOT.iterdir()}
    for relative in REMOVED_TOP_LEVEL:
        if relative in top_level_names:
            failures.append(f"legacy top-level path still exists: {relative}")

    for target in sorted(local_markdown_targets(readme)):
        if not (ROOT / target).exists():
            failures.append(f"README.md has a broken local link: {target}")

    for relative in tracked_files():
        normalized = f"/{relative}"
        if relative.startswith("output/"):
            failures.append(f"generated output is tracked: {relative}")
        if any(part in normalized for part in FORBIDDEN_TRACKED_PARTS):
            failures.append(f"generated or local file is tracked: {relative}")
        if relative.endswith((".tsbuildinfo", ".zip", ".skill", ".xcuserstate")):
            failures.append(f"build artifact is tracked: {relative}")
        if relative == "scripts/check_repo_structure.py":
            continue
        path = ROOT / relative
        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for pattern in LEGACY_REFERENCE_PATTERNS:
            if pattern.search(content):
                failures.append(f"legacy path reference remains in {relative}: {pattern.pattern}")

    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("Repository structure check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
