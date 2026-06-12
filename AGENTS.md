# AGENTS.md

## Scope
- `plottimation_webtool/` is the main application.
- Treat this as a browser-first app.
- Do not create a separate desktop/Electron fork unless explicitly requested.

## Architecture
- The app has three alignment pipelines:
  - `Markers`
  - `Markerless`
  - `Per-frame` (one uploaded image per animation frame; see `per_frame_pipeline_plan.md`)
- `Markerless` currently has two stabilization methods:
  - `Neighbor Comparison`
  - `Median-Frame Comparison`
- Third-party runtime assets live under `js/vendor/`.
- Large-image CV now uses a split image model:
  - styled/full-color Mats are BGR
  - vision/alignment Mats are grayscale
  - the `Rectified Grid` panel may show a downscaled preview while extraction still uses the full `baseRectifiedMat`

## Key Files
- `index.html`: primary UI markup
- `style.css`: global UI styling
- `js/app.js`: main orchestration, extraction flow, preview logic, rectified-grid overlays
- `js/pipeline.js`: page detection, marker detection, markerless estimation
- `js/ui-controls.js`: event wiring and interaction behavior
- `js/i18n.js`: locale tables, tooltips, translation helpers
- `js/settings-defaults.js`: canonical reset values
- `js/settings-io.js`: settings load/save compatibility
- `js/preview-controller.js`: playback ordering and preview loop logic
- `js/export-controller.js`: GIF/MP4/ZIP export logic
- `llm_readme.md`: technical handoff and subsystem notes
- `documentation.md`: user-facing documentation

## Behavioral Invariants
- Marker and markerless pipelines intentionally expose different UI semantics.
- Markerless corner overrides are post-stabilization extraction nudges.
- `Light-on-dark design` affects both pipelines.
- `Post-Rotation` is applied after page rectification and before marker detection or markerless autocorrelation.
- `Post-Rotation` positive values are intentionally clockwise in both the scrub preview and the final processed result.
- `Post-Rotation` scrubbing is preview-only while dragging; the expensive full CV reprocess should still happen only on release.
- Saved settings should remain backward-compatible when practical.
- If a settings file omits `frame_count_to_export`, treat that as `Frame Rows × Frame Columns`.
- If a settings file provides both `output_width` and `output_height`, preserve that exact pair instead of re-deriving one dimension from the other during load.
- `source_credit` metadata is shown at the top of the Status text. The old Page Corners header
  credit line is kept synchronized in code, but hidden to preserve header space for override buttons.
- Manual Page Corners overrides are source-image-space page quadrilaterals. They should override
  automatic page detection, disable `Page Detection Threshold`, and persist through settings files.
- If page detection fails entirely, enabling Page Corners overrides seeds a simple inset rectangle
  so the user can build a page quad manually.
- Live Page Detection Threshold preview fallback quads must not be stored as manual Page Corners
  overrides. Only explicit user edits should populate `state.source.manualPageContour`.
- `Frames in Export` limits preview and export from the same source-cell subset.
- `Processing frames n/m` reports chunked generation of final preview/export canvases after
  extraction, appearance, crop/geometry, stabilization, or targeted marker-override invalidation.
  Do not replace this with a synchronous all-frame rebuild.
- If pairwise markerless stabilization is enabled and its measurements are still running, final
  preview-frame warmup should wait; otherwise it can build unstabilized frames that are immediately
  invalidated when stabilization completes.
- Marker-mode manual marker overrides should invalidate only the neighboring frame cells touched
  by that marker unless enabled stabilization makes the whole sequence dependent on the edit.
- Page Detection Threshold live scrubbing is a lightweight Page Corners page-boundary preview. Keep it
  responsive and non-destructive; the full pipeline result on slider release is authoritative.
- Preview/export ordering changes must stay consistent with:
  - preview playback
  - paused arrow-key stepping
  - rectified-grid green current-frame overlay
  - rectified-grid red omitted-frame overlays
  - exported GIF/MP4/ZIP frame ordering
- If an exported GIF exists in the current session, the `Preview & Export` heading text links to
  that GIF via the generated object URL and `download` filename. Revoking the GIF URL must also
  remove that header link.

## Per-Frame Notes
- Per-frame mode treats each uploaded image as one animation frame; image count equals frame count.
  The rectified pages are resized to a common cell size and stacked into a synthetic 1×N composite
  `baseRectifiedMat`, after which extraction/stabilization/ordering/export run unchanged.
- Per-image page-corner overrides (and per-image post-rotation) are post-load, pre-rectification
  edits. They feed `rectifySinglePage` for that image only and never affect other images.
- Active-image switching is a UI navigation, not a config change: it redraws the raw photo, Page
  Corners overlay, and Post-Rotation slider for the newly active image but does NOT trigger
  reprocessing. The live composite/animation stays until a real config change.
- Per-frame mode disables the marker-specific and markerless-specific controls (marker editor,
  grid-edge controls, gutter/phase sliders, Rectified Grid pre/post toggle). Stabilization, Vertical
  Drift Compensation, Frame Corners overrides, ordering, appearance, and export stay enabled.
- Per-frame `_settings.txt` round-trip stores per-image overrides and post-rotation keyed by upload
  order plus the image count. Settings files carry no image data, so restoring a saved per-frame
  project requires re-uploading the same images in the same order; overrides reattach by upload
  order, not by filename.
- The per-frame composite cell size is clamped by long edge (uniformly, so the rectified-page /
 Layout paper aspect ratio is preserved) and held to the same total-area memory ceiling the
 single-page rectified path uses; if the median cell size would exceed either bound, `cellW`/`cellH`
 are scaled down uniformly so the composite Mat cannot blow up on large inputs.

## Markerless Notes
- Markerless pitch estimation comes from grayscale blurred autocorrelation.
- Markerless phase estimation uses combined gutter evidence.
- The current combined gutter signal is multiplicative.
- Markerless phase support currently uses a fixed band width in `pipeline.js`.
- Markerless stabilization is translation-only.

## Fragile Areas
- Cache invalidation in `js/app.js`
- Preview-frame warmup and the `Processing frames n/m` progress UI
- Mode-switched labels and tooltips
- Rectified-grid overlays
- Header/link sync for viewer titles should be idempotent. Avoid rewriting heading `textContent`
  during redraw loops unless the text actually changed, because that breaks text selection and
  appears as flicker.
- Post-Rotation scrub-preview behavior and handoff to the real processed result
- Large-image memory pressure during consecutive reprocesses
- Preview/export frame-order logic
- Settings load/save for newly added controls
- Markerless UI scrubbing behavior for responsive controls
- Layout controls that debounce or suppress redundant reprocessing

## Workflow Expectations
- Use `apply_patch` for manual file edits.
- When adding non-temporary UI controls:
  - wire settings load/save
  - add i18n labels
  - add tooltips
  - update user docs if the control is user-facing
- When adding temporary UI controls:
  - keep them clearly isolated
  - do not wire them into settings or i18n unless explicitly requested
- Prefer small, behavior-preserving refactors over large structural rewrites.

## Verification
- After JS edits, run lightweight parse checks.
- If shared UI changes, check all three pipelines (markers, markerless, per-frame).
- If viewer-tab or mobile-control naming changes, check mobile mode behavior.
- If settings-bearing controls change, check settings round-trip behavior.
- If Page Corners override behavior changes, check:
  - detected-page correction by dragging an existing green corner
  - no-page-detected fallback rectangle creation
  - `Clear Edits`
  - disabled `Page Detection Threshold` while edits exist
  - settings save/load of the edited page quad
- If `Rectified Grid` preview or rectified-image download behavior changes, check both:
  - the visible panel preview on large images
  - the full-resolution header-link download path sourced from `baseRectifiedMat`
- If paper-size / custom-sheet behavior changes, check:
  - preset -> custom with unchanged dimensions
  - debounced width/height typing
  - Enter-to-commit behavior
- If preview/export ordering changes, check:
  - reverse order
  - boustrophedon order
  - ping-pong
  - reduced frame-count export

## Documentation Split
- Put durable repo rules in this file.
- Put deeper implementation notes in `llm_readme.md`.
- Put user-facing explanations in `documentation.md`.
