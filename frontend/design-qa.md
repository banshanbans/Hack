# 长者友好家 H5 报告与档案编辑 QA

## Evidence

- Source visual truth: `/Users/carrey/Desktop/Screenshot 2026-07-25 at 16.02.53.png` (656 × 1428), plus the inline two-tab “我的” page wireframe supplied in the same request.
- Browser-rendered implementation:
  - `/private/tmp/anju-score-sheet-warm.png` (390 × 844)
  - `/private/tmp/anju-my-page-warm.png` (390 × 1646)
  - `/private/tmp/anju-selected-solution-warm.png` (390 × 1717)
  - `/private/tmp/anju-report-warm.png` (390 × 1859)
- Combined source/implementation comparison: `/private/tmp/anju-result-score-comparison.png` (798 × 844).
- Browser: Codex in-app browser.
- Viewport: 390 × 844 CSS pixels, device scale factor 1.
- Density normalization: the 656 × 1428 source was proportionally reduced to 388 × 844; the implementation remained at its native 390 × 844 capture size.
- State: real local assessment with a saved cane/one-fall/alone profile, one uploaded bathroom image, three analyzed risks and one selected B-tier solution.
- Downloaded image: `/Users/carrey/Downloads/长者友好家-居家安全检查报告.png` (1242 × 2106, PNG, 377 KB).

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
