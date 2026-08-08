# 长者友好家 H5 报告与档案编辑 QA

## Evidence

- Source visual truth: a user-supplied 656 × 1428 screenshot (not committed), plus the inline two-tab “我的” page wireframe supplied in the same request.
- Browser-rendered implementation:
  - score sheet (390 × 844, local QA artifact)
  - My page (390 × 1646, local QA artifact)
  - selected solution (390 × 1717, local QA artifact)
  - report (390 × 1859, local QA artifact)
- Combined source/implementation comparison: 798 × 844 local QA artifact (not committed).
- Browser: Codex in-app browser.
- Viewport: 390 × 844 CSS pixels, device scale factor 1.
- Density normalization: the 656 × 1428 source was proportionally reduced to 388 × 844; the implementation remained at its native 390 × 844 capture size.
- State: real local assessment with a saved cane/one-fall/alone profile, one uploaded bathroom image, three analyzed risks and one selected B-tier solution.
- Downloaded report image: 1242 × 2106 PNG, 377 KB (local QA artifact, not committed).

## Full-view comparison

- The result page preserves the source hierarchy: completion state, score/problem cards, main risk and result actions. The former standalone score-basis card is absent.
- Activating `查看评分依据` opens a compact bottom sheet over the current result context, with deterministic deduction rows and a dismiss action.
- The requested `#fffbe2` warm main color replaces the teal interaction palette. Dark brown foregrounds and borders maintain readable contrast on the pale surface.
- The fixed two-item tab bar stays visible on home, profile, rooms, upload, analysis, result, risk, solution, report and My routes.
- The My page follows the supplied single-scroll, collapsible-category structure and uses real profile, authenticated media thumbnails, room risks, selected solutions and budget data.
- Report checklist rows contain no to-do checkbox. Clicking a selected plan opens a dedicated single-plan detail page; choosing `更换方案` is the only path back to the three-option selector.
- All H5 and iOS user-visible product-name surfaces now use `长者友好家`; existing `Anju*` engineering identifiers remain unchanged.
- Editing a profile from My uses `/profile?from=my`; saving returns to My and does not enter the room-check flow.
- The report presents two explicit dimensions: evidence-backed hazards, and detailed selected actions with itemized material/labor/total budget. My downloads the same data as a PNG report instead of generating a share link.

## Required fidelity surfaces

- Fonts and typography: existing bundled Noto Sans SC / Plus Jakarta Sans remain intact. Heading hierarchy, compact section labels and large score/budget figures are readable without clipping.
- Spacing and layout rhythm: 24px mobile gutters, 12–16px card radii and compact section gaps match the existing H5 system. Persistent navigation has dedicated bottom padding and does not cover primary actions.
- Colors and visual tokens: app surfaces use `#fffbe2`; interactive foregrounds use dark brown rather than the previous teal. Risk red/amber/blue remain semantic and distinguishable.
- Image quality and asset fidelity: uploaded protected media is used for thumbnails and detail imagery. No placeholder drawings, handcrafted SVGs or emoji were introduced.
- Copy and content: all labels reflect live DTO values. Dates were not fabricated because the room DTO does not expose a user-facing inspection date.

Focused comparison was required for the score sheet because it intentionally replaces the standalone card visible in the source. The My page and selected-solution page were inspected at full captured resolution because they are new user-requested states rather than a pixel clone of the supplied result screenshot.

## Findings

- No actionable P0, P1 or P2 issue remains.
- P3: the My page displays “本次/已完成检查” rather than a calendar date until the API exposes room timestamps in its public DTO.

## Comparison history

1. Initial browser pass found that route cleanup recorded scroll position after HashRouter had already reset it, so returning from risk detail restored the result page to `scrollY=0`.
2. Scroll positions were changed to update continuously on the active route’s scroll event.
3. Post-fix browser evidence recorded `scrollY=511` before navigation and `scrollY=511` after returning from risk detail.
4. The final score-sheet comparison shows the standalone score card removed and the bottom sheet anchored correctly above the viewport edge.

## Primary interactions tested

- Started an assessment, explicitly saved the profile and opened a bathroom room.
- Uploaded a real local test image and completed live analysis.
- Opened and dismissed the score-basis bottom sheet.
- Scrolled the result page, opened risk detail, returned and verified numeric scroll restoration.
- Switched between Check and My tabs and verified profile, photo and risk aggregation.
- Selected the B-tier solution, returned to My, opened the selected row and verified that only the chosen solution’s details were shown.
- Opened the report and confirmed the removed continuation card and to-do boxes.
- Checked browser console errors: none.

## Implementation checklist

- [x] Replace standalone score-basis card with a bottom sheet.
- [x] Add persistent Check / My navigation.
- [x] Build the collapsible My aggregation page from existing APIs.
- [x] Apply the `#fffbe2` warm theme with accessible foreground contrast.
- [x] Restore per-route scroll positions.
- [x] Remove the report continuation card and checklist boxes.
- [x] Add a dedicated selected-solution detail route.
- [x] Fix the product name to 长者友好家 across user-visible H5/iOS surfaces.
- [x] Keep profile edits from My inside the My flow after explicit save.
- [x] Replace H5 share-link entry points with a structured PNG report download.
- [x] Run automated tests, production build and mobile browser QA.

final result: passed

---

# H5 首页参考图还原 QA（2026-08-09）

## Evidence

- Source visual truth: a user-supplied 347 × 905 JPEG (not committed and opened before implementation).
- Browser-rendered implementation: 347 × 905 local QA artifact (not committed).
- Combined full-view comparison: 694 × 905 local QA artifact, source on the left and implementation on the right.
- Focused comparisons:
  - Hero and brand region: 694 × 265 local QA artifact.
  - Progress and action card: 694 × 350 local QA artifact.
- Browser: Codex in-app browser.
- Viewport: 347 × 905 CSS pixels; implementation capture is 347 × 905 pixels, device scale factor 1.
- Density normalization: none required; source and implementation were compared at identical pixel and CSS dimensions.
- State: fresh H5 home state, onboarding dismissed, progress at step 1 of 6, camera capability available.

## Full-view comparison

- The implementation aligns the reference's major geometry: hero `x=19, y=70, 307×251`; progress card `x=19, y=344, 307×330`; primary action `x=41, y=530.5, 263×58`; resource grid `x=19, y=696, 307×133`; bottom navigation `x=0, y=835, 347×70`.
- The viewport has no horizontal or vertical overflow (`scrollHeight=905`, `scrollY=0`).
- The two-tab home navigation matches the reference while non-home routes retain the existing central-camera navigation entry.

## Required fidelity surfaces

- Fonts and typography: bundled Noto Sans SC / Plus Jakarta Sans render the Chinese display and UI copy without clipping. Headline wrapping, progress hierarchy and compact button labels match the source.
- Spacing and layout rhythm: outer gutters, section positions, card heights, radii, segmented progress and bottom navigation align with the 347 × 905 source geometry.
- Colors and visual tokens: off-white canvas, olive foreground, lime primary action, pale-yellow icon discs and white cards reproduce the supplied palette with readable contrast.
- Image quality and asset fidelity: the hero uses a dedicated 1536px AI-created raster asset with a warm living room and partially cropped safety-app phone. It matches the source art direction and slot dimensions without using a screenshot crop or placeholder drawing.
- Copy and content: brand, hero message, 1/6 progress, AR/photo/assistant actions, safety-guide cards and bottom tabs match the supplied screen. Existing session progress remains data-driven after step 1.

## Findings

- No actionable P0, P1 or P2 mismatch remains.
- P3: the generated living-room photo is not pixel-identical to the reference photograph, but matches its subject, warm palette, phone composition and overlay readability.

## Comparison history

1. First browser comparison found the hero starting at `y=56` instead of `y=70`, action controls 7px too high, 13px of avoidable page overflow, and a too-narrow phone crop.
2. Increased the brand/header region to 70px, moved the action stack down 7px, reduced bottom content padding to 75px, changed side gutters to 19/21px, and adjusted the hero focal position.
3. The post-fix browser capture matches all major source region coordinates, has no overflow, and the final full/focused comparisons show no remaining P0/P1/P2 issue.

## Primary interactions tested

- Opened and dismissed the central-camera introduction from `AR 实时识别` without requesting device permission.
- Navigated from `检查` to `我的` and back to the home route.
- Verified the fresh 1/6 state and the data-driven resume state through automated tests.
- Checked browser console errors: none.

## Implementation checklist

- [x] Rebuild the home composition from the selected 347 × 905 reference.
- [x] Preserve real assessment creation, progress recovery and camera capability gating.
- [x] Keep visible controls interactive and accessible.
- [x] Verify exact mobile viewport geometry and no-overflow behavior.
- [x] Run all frontend tests, typecheck, production build and product-copy validation.

final result: passed
