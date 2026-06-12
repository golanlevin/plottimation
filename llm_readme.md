# Plottimation Web Tool: Technical Handoff

This file is a technical handoff for future agents:

`codex resume 019dd258-f4b8-70b0-a8c4-0783ed8eb9df`

Additionally:

* Repo-level rules, workflow expectations, and durable invariants live in [AGENTS.md](/Users/gl/Desktop/plottimation/plottimation_webtool/AGENTS.md).
* User-facing explanations belong in [documentation.md](/Users/gl/Desktop/plottimation/plottimation_webtool/documentation.md).

## Purpose

`plottimation_webtool/` is a browser app that turns a photo or scan of a frame-sheet into:

- a live animated preview
- an exported animated GIF
- an exported H.264 MP4
- a ZIP of PNG frames plus settings
- a standalone settings text file

## Current Pipelines

### Markers

Used when frames are separated by explicit crosses or dots.

- page detection runs on a page-localization CV image
- coarse grid bounds are found from cross-convolution / boundary sweeps
- marker ROIs refine the nominal frame lattice
- `Auto` marker type resolves between `Crosses` and `Dots`

### Markerless

Used when frames are separated by empty gutters and there are no registration marks.

- branches immediately after page rectification
- does not use `Grid Edge Threshold` or `Grid Edge Run Length`
- estimates a straight lattice from the rectified grid
- emits synthetic corner intersections into the same `markerLookup` structure used by the marker pipeline

This shared output structure is why the same editing panel can be reused as:

- `Frame Alignment Markers` in marker mode
- `Frame Alignment Centers` / `Corners` in markerless mode

### Per-Frame

Used when each animation frame is its own uploaded image rather than one cell of a single
frame-sheet photo. Image count equals frame count (treated internally as a flat 1×N strip).

- `pipeline.js → runPerFramePipeline(images, config, requestId, throwIfAborted)` is the entry point;
  `runPipeline` dispatches to it when `config.alignmentPipeline === "per-frame"`.
- each uploaded image is page-rectified independently via `rectifySinglePage` (called with a per-image
  config copy aliased to `"markerless"`, carrying that image's `manualPageContour` and `postRotationDeg`)
- the rectified pages are resized to a single common cell size (median rectified dimensions, clamped
  uniformly by long edge so the Layout paper aspect survives, and held to the same total-area memory
  ceiling as the single-page rectified path) and stacked into a synthetic 1×N composite
  `baseRectifiedMat`
- synthetic corner intersections are emitted into the same `markerLookup` structure (via
  `buildUnrefinedCrossRegionInfo`), so downstream extraction/stabilization/ordering/export run unchanged
- per-image page-corner and post-rotation overrides are post-load, pre-rectification edits on the
  *active* image; switching the active image is UI navigation only and does not reprocess
- the image strip (`js/per-frame-strip.js`) handles select / reorder / delete / add; reorder and delete
  reprocess, select does not
- per-image overrides round-trip through `_settings.txt` keyed by upload order (see
  `js/settings-io.js`); reloading a saved project requires re-uploading the same images in the same order

The full implementation plan, including the phased build-out and the per-phase "As built" notes, lives
in [per_frame_pipeline_plan.md](per_frame_pipeline_plan.md).

## Light-on-dark design

`Light-on-dark design` is shared by the marker and markerless pipelines.

### Markers

- the raw source is inverted only for the CV path
- page detection and marker localization use the inverted image
- display and extracted frames remain in the original colors

### Markerless

- only the darkness contribution inside the gutter metric is inverted
- darker gutters are favored instead of lighter ones

## Markerless Grid Estimation

Implemented in [js/pipeline.js](/Users/gl/Desktop/plottimation/plottimation_webtool/js/pipeline.js).

### Pitch

- rectified grid ROI -> grayscale
- reduced to a manageable working size
- blurred
- horizontal and vertical pitch estimated from seeded autocorrelation

The seed period uses the inset ROI:

- `(rectifiedWidth - 2*searchInsetMarginX) / nCols`
- `(rectifiedHeight - 2*searchInsetMarginY) / nRows`

### Phase

The phase solver works from 1D gutter-support profiles, currently built from:

- darkness
- texture / edge energy
- local variance

Current combination rule:

- enabled terms are multiplied together

Current support width:

- fixed markerless phase band width of `3 px` in the reduced blurred grayscale image

The phase is not found by local peak picking. It is found by testing periodic lattice starts and
choosing the one whose expected gutter positions land on the strongest combined gutter signal.

### Grid Search Inset X/Y

In markerless mode:

- `Grid Search Inset X` and `Grid Search Inset Y` define the horizontal and vertical ROI that seeds pitch estimation
- it is visualized in `Rectified Grid` as a blue rectangle
- a value of `0` is valid and is the markerless default

## Markerless Stabilization

Stabilization is translation-only.

No rotation, scale, shear, or perspective correction is applied.

Two methods currently exist:

### Neighbor Comparison

Internal id:

- `pairwise-cyclic`

Behavior:

- compares nearby frames in the sheet/loop
- solves a weighted global offset field
- `Stabilization Rigidity` affects this method only

### Median-Frame Comparison

Internal id:

- `difference-from-average`

Behavior:

- builds one grayscale median reference frame from all pre-stabilization sampled frames
- aligns each frame independently against that reference
- does not use `Stabilization Rigidity`

### Shared matcher

Both methods reuse the same sampled grayscale matcher:

- reduced grayscale frames
- translation search window
- uniform-weight absolute-difference metric

The older radial/periphery weighting code is still retained in `js/app.js`, but it is currently
unused.

### Post-lattice adjustment stack

Markerless extraction adjustments currently stack in this order:

1. autocorrelation baseline
2. `Horizontal Phase Offset` / `Vertical Phase Offset`
3. `Vertical Drift Compensation`
4. solved stabilization translation
5. manual `Frame Corners` overrides

Important:

- markerless corner overrides are post-stabilization extraction nudges
- they must not feed back into the stabilization solve

## Preview / Export Ordering

Ordering logic lives primarily in [js/preview-controller.js](/Users/gl/Desktop/plottimation/plottimation_webtool/js/preview-controller.js).

Current behavior:

- preview and export both operate from the same ordered source-frame logic
- `Reverse Order`, `Boustrophedon Order`, and `Ping-Pong` apply to that ordered source list
- `Frames in Export` limits the included source frames before those order modifiers are applied
- omitted frames are always the highest-indexed source cells
- paused raw-grid inspection still respects `Frames in Export`, but it intentionally ignores
  playback ordering so arrow-key stepping can inspect the physical printed grid directly
- vertical paused stepping wraps within the valid cells of the current column, which matters when
  the last printed row is incomplete because `Frames in Export` omits trailing cells

The rectified-grid overlays must stay consistent with this ordering logic:

- green quad = currently displayed frame
- red omitted quads = source cells excluded by `Frames in Export`; these are drawn with a
  semi-transparent gray fill plus red outline and diagonal slash

This is a fragile integration point. If playback/export order changes, check:

- preview playback
- paused stepping
- rectified-grid green quad
- omitted red quads
- GIF/MP4/ZIP frame counts

## Preview Frame Warmup

Final preview/export frames are not the raw canvases returned by `runPipeline()`.

After geometry extraction, each displayed/exported frame may still need:

- source-cell extraction from `baseRectifiedMat`
- post-crop flip/rotation
- output-size scaling and resampling
- stabilization
- markerless phase/drift/corner nudges
- appearance filters

These final canvases are cached lazily through `getAdjustedFrameCanvas()`. To avoid silent playback
lag where the animation builds those canvases one frame at a time, `js/app.js` schedules chunked
warmup with `requestAnimationFrame`.

User-visible behavior:

- the Status panel shows `Processing frames n/m` with a progress bar
- the `Rectified Grid` header shows the same progress text
- if stabilization progress is also active, the header uses compact labels such as
  `Stabilizing i/j; Processing m/n`

Important implementation details:

- `schedulePreviewFrameWarmupForSourceIndices()` can warm a subset of source frames; this is used by
  marker overrides so moving one marker does not unnecessarily regenerate the whole animation
- `schedulePreviewFrameWarmup()` warms the current ordered preview/export source-frame set
- pairwise markerless stabilization intentionally blocks final frame warmup until pairwise
  measurements exist; otherwise the warmup would build unstabilized frames and immediately discard
  them when measurements finish
- synchronous all-frame rebuilds should be avoided unless there is a specific export-time reason

## Marker Override Cache Invalidation

Marker-mode manual overrides patch the current `alignmentInfo` in place and should not rerun the
full marker detector.

For a marker at lattice coordinate `(col, row)`, only up to four neighboring source cells can depend
on that marker:

- `(col - 1, row - 1)`
- `(col, row - 1)`
- `(col - 1, row)`
- `(col, row)`

`invalidateFramesForMarker()` returns that affected source-frame list when stabilization is disabled
or zero-strength, so the app can warm only those frames and show a short `Processing frames n/m`
phase. If stabilization is enabled with nonzero strength, it returns `null` because changed source
frames can affect the stabilization solve and the full output sequence may need regeneration.

## Rectified Grid Behavior

The `Rectified Grid` panel can render either:

- the full page warp before marker-grid cropping
- the extraction-space rectified grid used for frame extraction

The header `Pre` / `Post` radio buttons switch between these retained views:

- `Pre` = full page warp
- `Post` = cropped extraction-space grid

Default behavior:

- if a settings file was loaded with the source image, show the extraction-space rectified grid
- if no settings file was loaded, show the full page warp so Page & Grid Detection adjustments can
  be evaluated before the frame-grid crop/re-rectification step
- the radio choice is a local view preference, not a saved project setting

For large images, the visible panel image may be a downscaled preview canvas while extraction still
uses the full-resolution `state.geometry.baseRectifiedMat`. Overlay geometry therefore has to be
mapped from full rectified coordinates into the displayed preview size.

The `Rectified Grid` header link is sourced from the full-resolution rectified image, not from the
display preview:

- if the rectified grid long edge is `<= 3000 px`, a full-resolution download URL may be prepared
  eagerly
- otherwise the full-resolution asset is generated on demand from `state.geometry.baseRectifiedMat`
- the visible panel preview and the downloadable asset are intentionally different representations

Overlays currently include:

- blue frame-grid search quad when showing the full page warp
- magenta Grid Search Inset X/Y rectangle when showing the full page warp
- blue inset ROI rectangle in markerless mode
- green current-frame quad
- green connected edge preview while actively editing a marker/corner override
- red omitted-frame quads with a translucent gray fill and diagonal slash

## Page Detection Border-Quad Rescue

When full-resolution page detection selects (near-)the whole image as the largest quad,
`pipeline.js → refineBorderPageQuadWithDownscaledDetection` retries detection on a 512px downscale.
The retry first reuses the user's threshold method/offset; if that still yields a border quad it
tries Otsu candidates (`otsu` at the user offset, then `otsu` at offset 0), which handle bright
backgrounds that the default `offset-peak` threshold merges with the paper. A rescue quad is only
accepted when it is a substantial interior quad (≥10% area, not near the image border), so genuine
scanner-style full-bleed inputs still fall through to the source-boundary page.

## Page Detection Threshold Preview

`Page Detection Threshold` live scrubbing intentionally uses the lightweight grayscale preview cache for
Page Corners page-boundary feedback. If that downscaled preview fails to find a 4-corner page quad, the
preview path falls back to the full-resolution grayscale source before showing a warning.

Important behavior:

- live scrubbing clears stale Status text
- live scrubbing must not clear downstream Rectified Grid / marker / animation outputs by itself
- the full pipeline on slider release is authoritative and clears or sets the warning state
- if the low-res preview shows a contour that later fails full-resolution processing, the failure
  path clears the Page Corners contour instead of leaving a stale green frame

## Manual Page Corners Overrides

The `Page Corners` panel can store a manually edited source-space page quadrilateral in
`state.source.manualPageContour`.

Important behavior:

- `Enable Overrides` lets the user drag the green page-corner handles in the source image
- if no valid page boundary exists and the warning state is active, enabling overrides seeds a
  simple inset rectangle so the user can create a quad from scratch
- while a corner is dragged, a magnified picture-in-picture inset is shown in the opposite quadrant
- `Clear Edits` removes the manual quad and returns to automatic page detection
- when manual page-corner edits exist, `Page Detection Threshold` is disabled and its tooltip should
  tell the user to clear edits before using automatic threshold detection again
- manual page-corner edits are saved as `page_corner_override_tl`, `_tr`, `_br`, and `_bl`

Do not confuse these source-space page overrides with marker or markerless frame-corner overrides:
page-corner overrides feed the page rectification step, while frame/marker overrides happen after the
page has already been rectified.

Also keep preview fallback quads separate from true manual overrides. The lightweight
`Page Detection Threshold` preview may temporarily display a fallback quad, but it must not populate
`state.source.manualPageContour` unless the user explicitly edits Page Corners.

## Heading Links

Viewer heading text is used as a lightweight asset access surface:

- `Page Corners` links to the loaded source object URL when available
- `Rectified Grid` links to the full-resolution rectified image, generated eagerly for smaller
  sheets and lazily for larger sheets
- `Preview & Export` links to the latest generated GIF while `state.export.url` exists, using
  `state.export.filename` as the anchor `download` filename

Heading sync functions must be idempotent. Rewriting heading `textContent` on redraw breaks text
selection and looks like flicker.

Hidden-but-retained debug code still exists for the markerless gutter chart:

- left-to-right darkness / texture / variance / product curves
- code remains in `js/app.js` and `js/pipeline.js`
- the UI toggle and keyboard shortcut are currently disabled

## Settings Notes

Settings TSV support lives in [js/settings-io.js](/Users/gl/Desktop/plottimation/plottimation_webtool/js/settings-io.js).

Recent important keys:

- `alignment_pipeline`
- `stabilization_method`
- `stabilization_strength`
- `light_on_dark_design`
- `search_inset_margin_x_px`
- `search_inset_margin_y_px`
- `post_rotation_deg`
- `vertical_drift_compensation`
- `frame_count_to_export`
- `output_width`
- `output_height`
- `source_credit`
- `stabilization_enabled`
- `page_corner_override_tl`
- `page_corner_override_tr`
- `page_corner_override_br`
- `page_corner_override_bl`

Backward-compatibility note:

- legacy settings files may omit newer fields
- UI sync helpers are expected to supply correct defaults in that case
- in particular, a missing `frame_count_to_export` field should resolve to the full grid size, not
  to a one-frame export
- `source_credit` is currently rendered at the top of Status; the older Page Corners header credit
  line is still synchronized but hidden for header-space reasons
- legacy `search_inset_margin_px` should populate both `Grid Search Inset X` and
  `Grid Search Inset Y`
- when a settings file supplies both `output_width` and `output_height`, treat them as an exact
  stored pair during restore instead of recalculating one dimension from the other

## Memory Notes

Recent large-image work changed the internal image model:

- the `styled` CV branch is now BGR, not RGBA
- the `vision` CV branch is now grayscale, not color
- the lightweight Page Detection Threshold preview keeps only grayscale caches; the old persistent raw
  `source.cvMat` cache was removed

To reduce peak memory during consecutive large reprocesses:

- `trimCachesBeforeReprocess()` drops old rectified Mats and large frame/stabilization caches
  before the next `runPipeline()` begins
- the `Rectified Grid` panel uses a bounded preview canvas instead of materializing another
  full-size RGBA display copy for very large rectified pages

## Layout UI Notes

- Switching `Paper Aspect` between a preset and `Custom` should not trigger reprocessing if the
  effective sheet width/height did not actually change.
- `Sheet Width` and `Sheet Height` typing is intentionally debounced in the UI, while pressing
  `Enter` commits immediately.
- `Post-Rotation` is a page-detection-stage control: it rotates the rectified grid after page
  rectification and before marker detection or markerless autocorrelation.
- `Post-Rotation` positive values are intentionally clockwise in both the scrub preview and the
  final processed result.
- While scrubbing `Post-Rotation`, playback pauses and the app shows a preview-only rotated
  `Rectified Grid` plus preview-only Panel 3 tile updates. The expensive CV pipeline still runs
  only on release.
- The scrub preview is delta-based relative to the last processed rotation, not an absolute redraw
  from zero. This avoids double-applying an already-committed rotation when dragging from a
  nonzero starting value.

These are interaction expectations, not just implementation details. Regressions here make the app
feel frozen because page processing is expensive.

## Busy-Cursor Expectations

Some controls deliberately defer full recomputation until release, but they should still show the
geometry-processing cursor before the synchronous rebuild begins. Current examples:

- `Horizontal Phase Offset`
- `Vertical Phase Offset`
- `Vertical Drift Compensation`
- `Post-Rotation`
- `Enable Stabilization`
- `Stabilization Method`

If these controls are touched, preserve the "show busy cursor, yield one paint, then recompute"
behavior.

## Current Module Roles

Only the roles most relevant to future editing are listed here. See `AGENTS.md` for the broader file map.

- `js/app.js`
  - main orchestration
  - config reading
  - preview rendering
  - rectified-grid overlays
  - extraction/stabilization integration
  - cache invalidation

- `js/pipeline.js`
  - CV pipeline
  - markerless pitch/phase estimation
  - marker localization

- `js/preview-controller.js`
  - playback order
  - ping-pong expansion
  - current preview draw loop

- `js/export-controller.js`
  - GIF/MP4/ZIP export
  - exported frame count reporting

- `js/i18n.js`
  - locale tables
  - tooltip selector registry
  - mode-shared tooltips that sometimes need runtime overrides

## Common Failure Modes

- stale mode-switched labels or tooltips
  - some controls are shared between pipelines but need different text

- cache invalidation bugs
  - especially when scrubbing markerless controls or changing stabilization mode

- preview/export desynchronization
  - when ordering logic changes in one place but not another

- settings regressions for newly added controls
  - especially with legacy settings files that omit those fields

## Vendor Assets

Third-party runtime assets live in:

- [js/vendor/opencv.js](/Users/gl/Desktop/plottimation/plottimation_webtool/js/vendor/opencv.js)
- [js/vendor/gif.js](/Users/gl/Desktop/plottimation/plottimation_webtool/js/vendor/gif.js)
- [js/vendor/gif.worker.js](/Users/gl/Desktop/plottimation/plottimation_webtool/js/vendor/gif.worker.js)
- [js/vendor/mp4-muxer.esm.js](/Users/gl/Desktop/plottimation/plottimation_webtool/js/vendor/mp4-muxer.esm.js)

## TODO

- Consider a later refactor that extracts the source/rectified image-buffer ownership code from
  `js/app.js` into `js/image-buffer-lifecycle.js`.
  - Purpose:
    - make large-image memory policy easier to reason about
    - keep OpenCV Mat lifetime / deletion rules in one place
    - reduce how much `js/app.js` has to know about source/rectified buffer ownership
  - Likely contents:
    - `releaseSourceCvCaches()`
    - `ensureSourceCvCaches()`
    - `releaseRectifiedCvCache()`
    - `ensureBaseRectifiedMat()`
    - `ensureRectifiedGrayMat()`
    - `trimCachesBeforeReprocess()`
  - Scope note:
    - keep this focused on source and rectified image buffers, grayscale derivatives, and
      pre-reprocess memory trimming
    - do not move frame-output, stabilization, preview-order, or export logic into that file
