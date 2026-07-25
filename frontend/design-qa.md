# Stitch implementation QA

Reference source: `../../stitch_ai/1—9/screen.png` and `../../stitch_ai/harmonious_guardian/DESIGN.md`.

Implementation under test: production React build served directly by FastAPI with `ANJU_MOCK_ANALYSIS=1`. Screenshots were captured in a real Chromium session under `output/playwright/`.

## Visual comparison

| Page | Reference comparison | Result |
|---|---|---|
| P01 首页 | Same centered headline, square living-room hero, risk chips, two 52px+ actions and three capability cards | passed |
| P02 档案 | Same two-column mobility cards, full-width wheelchair card, grouped radio rows and bottom action | passed after forcing zero-minimum grid tracks and correcting the walker icon ligature |
| P03 房间 | Same 2×3 room grid, priority bathroom treatment and bottom actions; unsupported rooms add the required “规则完善中” state | passed |
| P04 上传 | Same dashed uploader, three photo guides, quality card and thumbnail rail; real upload adds usable/delete state | passed |
| P05 分析 | Same centered analysis title, annotated image, recognized-element chips and vertical progress; stage text comes from persisted job state | passed |
| P06 结果 | Same completion hierarchy, severity grouping, lead-risk image/card and bottom navigation; deterministic score and coverage cards are intentionally added | passed |
| P07 位置 | Same full-width annotated image and raised risk card; structured SVG overlay, switching, zoom, redraw and feedback are functional | passed |
| P08 方案 | Same A/B/C hierarchy and B visual emphasis without auto-selection; structured price ranges, actions, installation, expected gain and limitations are intentionally added | passed |
| P09 报告 | Same grouped checklist and save/share footer; coverage, projected score, budget split, task status and unknown-price state are intentionally added | passed |

The persistent amber Demo banner is an intentional product-safety difference when `ANJU_MOCK_ANALYSIS=1`. P05—P08 use the authenticated uploaded image at runtime rather than the static Stitch reference image; refresh recovery was verified with Blob URLs fetched through the assessment Bearer token.

## Responsive and interaction checks

- 320px, 390px and 480px mobile widths: no horizontal overflow; all primary actions remain at least 52px high.
- 1100px desktop viewport: 480px mobile canvas remains centered with a soft outer shadow.
- Browser refresh restores the assessment token, route, room media and completed result.
- P03 multi-room planning persists selected room records; only the bathroom offers a formal P0 analysis.
- P04 accepts and normalizes a real JPEG, reports quality, displays the authenticated thumbnail and allows deletion.
- P05 polling was held at a real persisted stage for visual QA, then allowed to complete normally.
- P07 bbox/polygon overlay and risk switching render against `object-fit: cover`; feedback and redraw controls are reachable by keyboard.
- P08 B is highlighted but enters the budget only after an explicit click; A/B/C remain mutually exclusive.
- P09 save and 24-hour read-only share both completed; the shared page contains no original image, profile or internal logs.
- Final browser console: 0 errors, 0 warnings. CSP font failures found in the first pass were fixed by permitting bundled `data:` font faces while retaining same-origin scripts and connections.
- `prefers-reduced-motion` disables nonessential animation; focus is moved to the page main region after HashRouter navigation.

final result: passed
