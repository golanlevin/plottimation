# Per-Frame Alignment Pipeline — Implementation Plan

This document plans the addition of a third `alignmentPipeline` mode — `"per-frame"` —
that lets the user upload N images, one per animation frame, instead of a single
frame-sheet photo. Each image is page-rectified independently and the rectified
results are stacked into a synthetic `baseRectifiedMat`, after which the existing
stabilization / ordering / appearance / export path runs unchanged.

This is an engineering plan, not user docs. User-facing copy belongs in
`documentation.md`; durable invariants belong in `AGENTS.md`.

## Locked Decisions

These were chosen up front so individual sessions do not need to relitigate them.

1. **Frame count = image count (Option 1A).** The number of uploaded images is the
   number of animation frames. Internally treated as a flat `1 × N` strip. The
   `Frame Rows` / `Frame Columns` Layout controls become display-only / disabled
   in per-frame mode.
2. **Rescale to common cell size (Option 2B).** After per-image page rectification,
   every cell is resized to a single common cell size (default: median rectified
   width × median rectified height). All cells in the synthetic `baseRectifiedMat`
   are the same size; stabilization and extraction work on uniform cells.
3. **Persist per-image overrides (Option 3A).** Page-corner overrides and
   post-rotation are saved per image using indexed settings keys
   (`page_corner_override_tl_0`, `..._tl_1`, …, `per_frame_post_rotation_deg_0`,
   …). Settings files round-trip cleanly.
4. **Single image in per-frame mode is allowed (Option 4A).** Loading a single
   image in per-frame mode produces a 1-frame animation. The user can add more
   images via the strip afterwards.

## Architectural Summary

- Add `"per-frame"` as a third value for `config.alignmentPipeline`.
- New per-image source structure under `state.source.images[]`; the existing
  `state.source.image` / `manualPageContour` / `dragUrl` / etc. become *views into*
  the active image (`state.source.images[state.source.activeImageIndex]`) so most
  legacy callers keep working.
- Factor out the page-detection + page-rectification block from
  `pipeline.js → runPipeline` into a reusable `rectifySinglePage(...)`. Markers and
  markerless modes continue to call it as before; per-frame mode calls it once per
  uploaded image.
- New `pipeline.js → runPerFramePipeline(images, config, …)`:
  1. Run `rectifySinglePage` per image (respecting per-image page-corner and
     post-rotation overrides).
  2. Pick a common cell size (median of rectified sizes; clamped so the composite
     fits within the existing large-image limits).
  3. Resize each rectified Mat to the common cell size.
  4. Concatenate horizontally into a single composite `rectifiedMat`
     (`cellWidth * N × cellHeight × 1` row × N column grid).
  5. Synthesize an `alignmentInfo` whose marker lookup contains regular corner
     intersections at the known cell boundaries.
  6. Return the same result shape that `runPipeline` returns.
- `runPipeline` becomes a dispatcher: per-frame → `runPerFramePipeline`; otherwise
  the existing markers/markerless path.
- Downstream (frame extraction, stabilization, ordering, appearance, export) does
  not branch on per-frame mode. The synthetic sheet looks like a 1×N markerless
  sheet to those subsystems.

## Phases

Each phase below is self-contained: it lists scope, files, acceptance criteria,
and explicit out-of-scope items so individual implementation sessions do not
overreach.

---

### Phase 0 — Spike (½ day, throwaway)

**Goal:** prove that a tiled composite Mat plus existing stabilization can produce
a working animation end-to-end, before doing any real refactoring.

**Scope:**
- Hardcode two demo images (or load two arbitrary images via the existing file
  input twice in sequence).
- Add a dev-only code path that builds a `2 × cellW × cellH` composite Mat from
  the two latest rectified Mats and stuffs it into `state.geometry.baseRectifiedMat`
  alongside a fake `alignmentInfo` with two cell corners.
- Confirm: preview animates, stabilization measurement runs, GIF export produces
  the expected 2-frame GIF.

**Files touched (throwaway code, do not merge as-is):**
- `js/app.js` — small scratch block, clearly marked `// SPIKE: per-frame, remove`.

**Acceptance:**
- Two-frame GIF exports correctly.
- Stabilization runs without errors and offsets are non-zero when the two source
  images are deliberately misregistered.
- Nothing about the marker/markerless code paths regresses for a normal source
  image.

**Out of scope:**
- Real UI, real `state.source.images[]`, settings, i18n, mobile, memory trimming.
- Any code that should survive into Phase 2+.

**Rollback:** delete the spike block; no other files were touched.

---

### Phase 1 — Refactor: extract `rectifySinglePage`

**Goal:** isolate the page-detection + page-rectification stage of `runPipeline`
into a reusable helper without behavioral change to markers or markerless mode.

**Scope:**
- In `js/pipeline.js`, factor lines roughly 250–385 of `runPipeline` (page
  detection through `applyPostRectificationRotation`) into a new function:
  ```
  rectifySinglePage(sourceCanvas, perPageConfig, requestId, throwIfAborted)
    -> { rectifiedWarp, pageQuad, pageQuadSource, pageWarpPreviewCanvas,
         pageWarpPreviewWidth, pageWarpPreviewHeight,
         useNearIdentityRectification }
  ```
  Caller is responsible for Mat lifetime of the returned `rectifiedWarp`.
- `perPageConfig` is a strict subset of the full config: `paperAspect`,
  `manualPageQuadPoints`, `fallbackPageQuadPoints`, `thresholdMethod`,
  `thresholdOffset`, `postRotationDeg`, `lightOnDarkDesign`, `alignmentPipeline`
  (still needed because near-identity fast-path branches on markerless).
- `runPipeline` is unchanged behaviorally; it just calls `rectifySinglePage` and
  then proceeds with the existing grid-rectification + alignment + extraction
  path.

**Files touched:**
- `js/pipeline.js`

**Acceptance:**
- Demo round-trip on every demo image listed in `index.html#loadDemoSelect`
  produces visually identical previews to `main`.
- Settings save/load round-trip is byte-identical.
- No new console errors. Memory profile during a large-image reprocess does not
  regress (peak Mat count unchanged).
- `runPipeline` is meaningfully shorter; `rectifySinglePage` has a clear contract
  documented in JSDoc.

**Out of scope:**
- Any per-frame mode code.
- Any change to `runPipeline`'s output shape.
- Any change to the marker/markerless detector functions.

**As built (Phase 1 — COMPLETE):**
- `rectifySinglePage` was implemented in `js/pipeline.js`, taking the
  **full `config` object** rather than the trimmed `perPageConfig` subset
  proposed above. The block it owns (`buildFrameGridRectification_fromCrosses`,
  via the marker path) needs the frame-grid fields (`useRectifiedAsSource`,
  `frameCols`, `frameRows`, `crossRoiScale`, `paperMarginXPx`, `paperMarginYPx`,
  `boundarySensitivity`, `boundaryPersistencePx`) in addition to the page-stage
  fields, so passing a strict subset would have meant re-threading the entire
  grid config anyway. The JSDoc on `rectifySinglePage` enumerates exactly which
  `config` keys it reads. Phase 3's per-image call therefore passes a shallow
  copy of `config` with per-image overrides (see Phase 3, step 2).
- Actual signature/return:
  ```
  rectifySinglePage(sourceCanvas, config, requestId, throwIfAborted)
    -> { rectifiedWarp, pageQuad, pageQuadSource, pageWarpPreviewCanvas,
         pageWarpPreviewWidth, pageWarpPreviewHeight,
         useNearIdentityRectification, threshVal, pageSizeLow, pageSizeHigh }
  ```
  `threshVal`, `pageSizeLow`, and `pageSizeHigh` were added beyond the proposed
  shape so `runPipeline` can keep building byte-identical status text.
- Mat lifetime: `rectifySinglePage` releases every intermediate Mat in its own
  `finally` and releases `rectifiedWarp` in its `catch` on failure, so the
  caller only ever owns a successfully returned `rectifiedWarp`. `runPipeline`'s
  `finally` shrank to just deleting `rectifiedWarp.visionMat` / `styledMat`.
- Error handling: `rectifySinglePage` attaches `error.partialResult` for
  page-stage failures; `runPipeline` only fills it in for later
  (alignment/extraction) failures, guarded by `!error.partialResult`.
- Phase 0 spike code in `js/app.js` (the `SPIKE_PER_FRAME` constants and the
  2-frame composite block in `processCurrentImage`) was removed as part of this
  work. Verified via demo round-trip; markers and markerless modes unchanged.

---

### Phase 2 — State: `state.source.images[]` and active-image accessor

**Goal:** introduce per-image source state without yet adding any UI or pipeline
support. Existing markers/markerless flows continue to use the active image
transparently.

**Scope:**
- In `js/dom-state.js`, extend `state.source`:
  ```
  images: [],            // [{ image, filename, mimeType, ownedObjectUrl, dragUrl,
                         //    canvas, manualPageContour, postRotationDeg,
                         //    rectifiedMatCache: null, rectifiedDirty: true }]
  activeImageIndex: 0,
  ```
- Add accessor helpers (likely in a new tiny module `js/source-images.js`, or
  inline in `dom-state.js`):
  - `getActiveSourceImage(state)` returns the active entry, or `null`.
  - `setActiveSourceImage(state, index)`.
  - `releaseAllSourceImages(state)` revokes object URLs and clears Mats.
- Mutate `load-controller.js → loadImageSource` to push the loaded image into
  `state.source.images` as a single-entry array and set `activeImageIndex = 0`,
  while *also* keeping the existing `state.source.image / filename / dragUrl /
  manualPageContour` fields populated. The legacy fields become projections of
  the active entry for the duration of the migration.
- No mode logic yet — `state.source.images[]` always has exactly 0 or 1 entries
  during this phase.

**Files touched:**
- `js/dom-state.js`
- `js/load-controller.js`
- new `js/source-images.js` (optional)

**Acceptance:**
- Markers and markerless modes still load the same demos and round-trip
  identically.
- `releaseOwnedSourceUrl` is replaced by / wraps `releaseAllSourceImages`; no
  blob URLs leak across reloads.
- Loading a new image clears prior `images[]` entries.

**Out of scope:**
- Multi-file `handleFile`. (That arrives in Phase 4.)
- Per-image overrides. (Phase 5.)
- Any UI for the image strip.

**As built (Phase 2 — COMPLETE):**
- `state.source` gained `images: []` and `activeImageIndex: 0` in `js/dom-state.js`.
  The legacy `state.source.image / filename / mimeType / dragUrl / ownedObjectUrl /
  canvas / manualPageContour` fields stay populated and are treated as projections
  of the active entry.
- New module `js/source-images.js` exports:
  - `createSourceImageEntry(fields)` — builds an entry with the documented shape
    (`image, filename, mimeType, ownedObjectUrl, dragUrl, canvas,
    manualPageContour, postRotationDeg, rectifiedMatCache: null,
    rectifiedDirty: true`).
  - `getActiveSourceImage(state)` — active entry or `null`.
  - `setActiveSourceImage(state, index)` — clamps and returns the new active entry.
  - `releaseAllSourceImages(state)` — revokes per-entry blob URLs, frees cached
    Mats, resets `images` to `[]` and `activeImageIndex` to `0`.
  - `releaseEntryRectifiedCache(entry)` — helper that frees either a bare `Mat` or
    a `{ visionMat, styledMat }` rectified-warp cache (added beyond the proposed
    list because Phase 9 / Phase 3 caches use that shape).
- `js/load-controller.js`:
  - `loadImageSource`'s `image.onload` now registers the loaded image as the single
    entry (`state.source.images = [entry]; activeImageIndex = 0`). The entry's
    `canvas` aliases the shared `state.source.canvas` (only one image exists in this
    phase); the entry's `manualPageContour` is mirrored from the legacy field after
    any settings file is applied. **Note for Phase 4:** this canvas aliasing is only
    safe while `images[]` holds at most one entry — Phase 4 must give each entry its
    own dedicated canvas (see Phase 4 scope).
  - `releaseOwnedSourceUrl(state)` now wraps `releaseAllSourceImages(state)` before
    revoking the legacy `ownedObjectUrl`, so loading a new image clears prior
    `images[]` entries and no blob URLs leak across reloads.
- No mode logic, multi-file handling, per-image overrides, or strip UI were added.
  Markers/markerless flows are unaffected (changes are additive; the legacy fields
  the pipeline reads remain authoritative).

---

### Phase 3 — Pipeline: `runPerFramePipeline` + dispatcher

**Goal:** wire the new per-frame pipeline behind the existing `runPipeline`
contract. No UI yet — exercised through manual config hacking or unit-level
testing.

**Scope:**
- In `js/pipeline.js`:
  - Add `runPerFramePipeline(images, config, requestId, throwIfAborted)`:
    1. For each `image` in `images`, build a per-image `sourceCanvas` (already
       in `state.source.images[i].canvas`).
    2. Call `rectifySinglePage(sourceCanvas, perImageConfig, …)`. As implemented
       in Phase 1, `rectifySinglePage` takes the **full `config` object** (not a
       trimmed `perPageConfig` subset) and reads the page-relevant fields plus the
       frame-grid fields needed by the marker rectifier; its JSDoc lists exactly
       which keys it consumes. So `perImageConfig` is a shallow copy of the base
       `config` with the per-image fields overridden:
       ```
       const perImageConfig = {
         ...config,
         // Treat each rectified page as a whole working sheet (no cross sweep,
         // no frame-grid crop). rectifySinglePage branches its near-identity
         // fast path and grid rectification on this value, so per-frame mode
         // must alias to "markerless" here rather than passing "per-frame".
         alignmentPipeline: "markerless",
         // Per-image page-corner override (source-space quad) for this image.
         manualPageQuadPoints: images[i].manualPageContour ?? null,
         // No live threshold-preview fallback when rectifying per image.
         fallbackPageQuadPoints: null,
         // Per-image Post-Rotation (Phase 5 stores this on the image entry).
         postRotationDeg: images[i].postRotationDeg ?? 0,
       };
       ```
       The base `config.alignmentPipeline` stays `"per-frame"` for the dispatcher
       and for downstream readConfig/UI gating; only the per-image copy handed to
       `rectifySinglePage` is aliased to `"markerless"`.
    3. From each call, take `result.rectifiedWarp`; the caller owns it (per the
       Phase 1 contract). Use `rectifiedWarp.styledMat` as the cell source and
       delete `rectifiedWarp.visionMat` immediately (per-frame mode does not run
       per-image alignment on it). Each `styledMat` is deleted after it has been
       resized/copied into the composite in step 6.
    4. Decide common cell size:
       - `cellW = clamp(median(rectifiedWidths), MIN_CELL_PX, MAX_CELL_PX)`
       - `cellH = clamp(median(rectifiedHeights), MIN_CELL_PX, MAX_CELL_PX)`
       - Limits chosen to keep `cellW × cellH × N` inside existing
         `RECTIFIED_PREVIEW_LONG_EDGE_PX` / large-image-memory budgets.
    5. Resize each rectified `styledMat` to `(cellW, cellH)` using the
       interpolation flag from `config.exportOptions.resampling`.
    6. Allocate composite `rectifiedMat` of size `(cellW * N, cellH)` and copy
       each resized cell into its column.
    7. Synthesize `alignmentInfo` whose corner intersection points are at
       `(i * cellW, 0)`, `((i+1) * cellW, 0)`, `(i * cellW, cellH)`,
       `((i+1) * cellW, cellH)` for `i = 0 … N`. The structure should match what
       `buildUnrefinedCrossRegionInfo` produces for a 1×N markerless sheet.
    8. Build a `rectifiedCanvas` preview from the composite Mat using the
       existing `matToPreviewCanvas`.
    9. Extract frame canvases via the existing `sliceRectifiedToCanvases` so the
       returned `frames` array matches what marker/markerless modes produce.
   10. Return the same result shape as `runPipeline`: `{ frames, rectifiedCanvas,
       rectifiedMat, pagePreviewCanvas: null, pagePreviewGridQuad: null,
       pagePreviewGridBounds: null, alignmentInfo, statusText, pageQuadPoints:
       null, pageQuadSource: "per-frame", rectifiedDownloadUsesRawSource: false }`.
       (`pagePreview*` is null because there is no single "page" in per-frame mode;
       Phase 7 will hide the corresponding UI.)
  - Modify `runPipeline` so its first lines dispatch:
    ```
    if (config.alignmentPipeline === "per-frame") {
      return runPerFramePipeline(state.source.images, config, requestId, throwIfAborted);
    }
    ```
    `runPipeline` should not import `state` directly; pass `images` from the
    caller. So update the caller in `app.js → processCurrentImage` to pass
    `state.source.images` alongside `state.source.canvas`.
- `app.js → readConfig`: when the per-frame radio is checked, set
  `alignmentPipeline: "per-frame"`. Also force `useCrossAlignment: false` for
  this mode (the synthetic grid does not need refinement).

**Files touched:**
- `js/pipeline.js`
- `js/app.js` (readConfig + the `runPipeline` invocation site only)

**Acceptance:**
- With per-frame mode forced via dev console (`dom.alignmentPipelineMarkerless.checked = false; dom.alignmentPipelineMarkers.checked = false; /* + manual flag */`)
  and two images loaded via dev hack, a 2-frame animation appears in
  `gifPreviewCanvas` and exports correctly.
- Stabilization measurement runs on the synthetic sheet without errors.
- Markers/markerless flows continue to work unchanged.
- Memory: `MAX_CELL_PX` and median selection keep peak Mat size bounded.

**Out of scope:**
- The "per-frame" radio button itself (Phase 6 adds it).
- Multi-file upload (Phase 4).
- Per-image overrides (Phase 5).
- UI strip (Phase 7).
- Settings persistence (Phase 8).

**As built (Phase 3 — COMPLETE):**
- `js/pipeline.js`:
  - Added `runPerFramePipeline(images, config, requestId, throwIfAborted)`. It filters the entries
    to those with a `canvas`, throws if none, then per image calls `rectifySinglePage` with a shallow
    `config` copy overriding `alignmentPipeline: "markerless"`, `manualPageQuadPoints:
    entry.manualPageContour ?? null`, `fallbackPageQuadPoints: null`, `postRotationDeg:
    entry.postRotationDeg ?? 0`. The grayscale `visionMat` is deleted immediately; only the styled
    (BGR) page is kept as the cell source.
  - Common cell size is `Math.round(clamp(median(dim), PER_FRAME_MIN_CELL_PX,
    PER_FRAME_MAX_CELL_PX))` per dimension (new constants `16` / `1600`). The strict composite-area
    ceiling and uniform scale-down remain deferred to Phase 9; this is the per-dimension guard.
  - Each styled page is resized (or `copyTo` when already cell-sized) into its column of a
    `cv.CV_8UC3` composite via `composite.roi(...)`, then freed right after it is consumed. The
    `finally` block releases any still-unconsumed per-image Mats and the composite itself if the
    function throws before handing it off.
  - `alignmentInfo` is synthesized with `buildUnrefinedCrossRegionInfo(composite, N, 1, "per-frame",
    fullBounds, config.crossRoiScale, { markerType: "crosses", includeCornerCrosses: true })` — i.e.
    a 1×N markerless-style lattice with regular corner intersections at the column boundaries.
  - Frames come from the existing `sliceRectifiedToCanvases`; the preview canvas from
    `matToPreviewCanvas`. `statusText` is built from existing `status.framesExtracted` /
    `status.rectifiedSheet` / `status.animationSize` keys (no new i18n strings). The return shape
    matches `runPipeline` with `pagePreview*` null, `pageQuadSource: "per-frame"`,
    `rectifiedDownloadUsesRawSource: false`.
  - `runPipeline` gained an optional 5th param `images = null` and dispatches to
    `runPerFramePipeline` when `config.alignmentPipeline === "per-frame"` before the single-page
    path. It still does not import `state`; `images` is passed in by the caller.
- `js/app.js`:
  - `readConfig` computes `perFrameModeActive = !!dom.alignmentPipelinePerFrame?.checked ||
    !!state.runtime.forcePerFrameMode`. The radio ref is read with optional chaining so this is
    forward-compatible with the real radio added in Phase 6. `alignmentPipeline` emits `"per-frame"`
    when active, and `useCrossAlignment` is forced `false` in that mode.
  - The `runPipeline` invocation site now passes `state.source.images` as the 5th argument.
- `js/dom-state.js`: added `state.runtime.forcePerFrameMode = false` — a Phase 3 dev flag so the
  pipeline can be driven from the console before the Phase 6 radio exists. Set it `true` (with images
  loaded) and reprocess to exercise per-frame mode.
- No other `app.js` sites were touched (e.g. the markerless stabilization-warmup gating at the
  `processCurrentImage` tail). Mode-gated downstream behavior — including auto-scheduling
  stabilization for per-frame — is deferred to Phase 6's `=== "markerless"` audit, per this phase's
  "readConfig + the runPipeline invocation site only" scope.

---

### Phase 4 — Multi-file upload (`handleFile`, drop zone)

**Goal:** support dragging or selecting multiple image files at once. Always
populate `state.source.images[]`; never silently drop additional images.

**Scope:**
- `js/load-controller.js → handleFile`: when multiple image files are present in
  the drag payload (or file input), build per-image entries for each. Sibling
  `_settings.txt` is still matched against the first image's filename and applied
  once after all images are loaded.
- **Per-entry canvases (carried over from Phase 2):** Phase 2 left each entry's
  `canvas` aliasing the shared `state.source.canvas`, which is only safe while
  `images[]` holds at most one entry. Phase 4 introduces multiple entries, so each
  entry **must** get its own dedicated source-resolution `canvas` drawn from its
  own decoded image (do not reuse the shared `state.source.canvas` for more than
  one entry, or every cell in `runPerFramePipeline` would rectify the same image).
  The legacy `state.source.canvas` / `state.source.image` should then project the
  **active** entry (e.g. point `state.source.canvas` at
  `images[activeImageIndex].canvas`), so legacy single-image callers keep reading
  the active image. Update the single-image load path accordingly so it produces a
  per-entry canvas too, keeping one code path for the 1-image and N-image cases.
- `index.html`: `<input id="fileInput" … multiple />` and drop-zone copy update.
- `js/i18n.js`: drop-zone copy strings for per-frame mode (and a generic copy
  that mentions multi-file support; localize across all locale tables).
- After multi-file load, if the currently selected pipeline is **not**
  `"per-frame"`, the app should auto-switch to `"per-frame"` (this is the most
  forgiving UX). Otherwise the user just dropped 12 files into a markerless app
  and would silently lose 11 of them.
- Single-image drops continue to behave exactly as before.

**Files touched:**
- `index.html`
- `js/load-controller.js`
- `js/i18n.js`

**Acceptance:**
- Drag-and-drop with 1 image: identical to current behavior.
- Drag-and-drop with N images: app switches to per-frame mode, loads all N,
  active index is 0, animation appears.
- File picker with multi-select: same behavior as drag.
- Mixed drag (N images + 1 `_settings.txt`): settings file is applied against
  the first image's name; per-frame mode is selected if N > 1.
- Each loaded entry has its own distinct `canvas` (no two entries share a canvas
  reference, and none alias the shared `state.source.canvas` once N > 1).

**Out of scope:**
- Strip UI (Phase 7).
- Reorder/delete buttons (Phase 7).
- Settings-driven per-image overrides on reload (Phase 8 plus Phase 5).

**As built (Phase 4 — COMPLETE):**
- `js/load-controller.js`:
  - Added a module-level `decodeImageElement(src)` helper that resolves a loaded
    `HTMLImageElement` (rejects on decode failure) for the additional per-frame images.
  - `handleFile` now collects **all** image files (`imageFiles = allFiles.filter(isImageFile)`),
    treats the first as the primary, and passes the rest as `additionalImageFiles`
    (`imageFiles.slice(1)`). The sibling `_settings.txt` is still matched against the **first**
    image's expected name and applied once. A lone settings file still routes to `applySettingsFile`.
  - `loadImageSource` gained an `additionalImageFiles = []` dep. In `image.onload` each entry now
    gets its **own** dedicated source-resolution canvas (`document.createElement("canvas")` +
    `drawImageToCanvas`), replacing the Phase 2 aliasing of the shared `state.source.canvas`. The
    legacy `state.source.canvas` is repointed at the active (index 0) entry's canvas, and
    `state.source.image` continues to project the primary image. Additional images are decoded in a
    loop; each owns its own blob URL + canvas, and a failed decode revokes that URL and is skipped
    (it does not abort the whole load). This is one code path for the 1-image and N-image cases.
  - When more than one image is loaded, per-frame mode is forced on
    (`state.runtime.forcePerFrameMode = true`, plus `dom.alignmentPipelinePerFrame.checked = true`
    when that radio exists — forward-compatible with Phase 6). Single-image loads do **not** touch
    the mode, so a fresh single drop behaves exactly as before. The activation happens before
    settings application and `processCurrentImage`; because `readConfig` OR-s `forcePerFrameMode`
    with the radio, multi-image always resolves to per-frame even if a sibling settings file selected
    markers/markerless.
  - Mat/URL lifetime is unchanged in spirit: `releaseOwnedSourceUrl` → `releaseAllSourceImages`
    already revokes every per-entry `ownedObjectUrl` and frees per-entry canvases/Mats on the next
    load, so the extra blob URLs do not leak.
- `js/app.js`: the wrapper `loadImageSource(src, filename, mimeType, settingsFile,
  additionalImageFiles = [])` threads the new argument into `loadImageSourceViaController`. Demo
  loads (2-arg calls) are unaffected (default `[]`, single image, no per-frame switch).
- `index.html`: `#fileInput` gained the `multiple` attribute so the file picker allows multi-select.
- `js/i18n.js`: added a `photo.dropNotePerFrame` string to **all 13** locale tables (per-frame
  guidance copy, wired into the visible drop note in Phase 6) and extended the generic `dropZone`
  tooltip in all 13 locales to mention dropping several images at once (one per frame).
- Not touched: `js/ui-controls.js` (the existing drop/`change` listeners already forward the full
  `FileList`), the strip UI, reorder/delete, and any settings persistence — all deferred to later
  phases.

---

### Phase 5 — Per-image page-corner and post-rotation overrides

**Goal:** make the existing Page Corners editor and Post-Rotation control operate
on the *active* image in per-frame mode.

**Scope:**
- Route `state.source.manualPageContour` reads/writes through the active image
  in per-frame mode. Concretely, where `app.js` currently writes
  `state.source.manualPageContour = …`, replace with a helper
  `setActiveManualPageContour(state, contour)` that:
  - in per-frame mode, writes to `state.source.images[activeIndex].manualPageContour`
    and also mirrors to the legacy field (so other read sites keep working);
  - in markers/markerless modes, writes the legacy field directly (no-op for
    `images[]`).
- Same treatment for `postRotationDeg` (per-image storage; the slider reads/writes
  the active image's value in per-frame mode).
- Switching active image redraws `rawCanvas`, Page Corners overlay, and
  Post-Rotation slider position to match the newly active image. The rectified
  preview / animation are *not* rebuilt on active-image switch — that is a UI
  navigation, not a config change.
- Page Detection Threshold remains a global control (acts on all per-frame
  images when reprocessing). Per-image threshold is out of scope for v1.

**Files touched:**
- `js/app.js` (Page Corners drag handlers, Post-Rotation handlers, redraws)
- `js/dom-state.js` (per-image fields added in Phase 2)
- `js/ui-controls.js` (active-image switching invalidations)

**Acceptance:**
- In per-frame mode with 3 images, the user can edit page corners on image #2
  without affecting images #1 or #3.
- Switching active image redraws the Page Corners overlay with that image's
  saved corners.
- Reprocessing uses every per-image override correctly.
- Markers/markerless modes are completely unaffected.

**Out of scope:**
- UI strip (Phase 7) — at this point active-image switching can be triggered by
  dev console (`state.source.activeImageIndex = 1; renderRawPreview();`).
- Persisting overrides to disk (Phase 8).

**As built (Phase 5 — COMPLETE):**
- The per-image accessors this phase needs (`setActiveManualPageContour(state,
  contour, perFrameMode)` and `setActivePostRotationDeg(state, deg, perFrameMode)`)
  already live in `js/source-images.js` — they take an explicit `perFrameMode`
  boolean rather than re-deriving the mode inside the module, so `source-images.js`
  stays DOM-free. `setActiveManualPageContour` always writes the legacy
  `state.source.manualPageContour` and, only when `perFrameMode`, also mirrors to
  the active entry's `manualPageContour`. `setActivePostRotationDeg` writes **only**
  the active entry's `postRotationDeg` and is a no-op outside per-frame mode (the
  legacy global stays the slider/`config.postRotationDeg`). No new accessors were
  needed.
- `js/app.js`:
  - New `isPerFrameModeActive()` helper centralizes mode detection as
    `!!dom.alignmentPipelinePerFrame?.checked || !!state.runtime.forcePerFrameMode`
    (optional-chained for the not-yet-existing Phase 6 radio). `readConfig` now
    calls it instead of inlining the same expression, so config emission and
    override routing can never diverge.
  - The three user-driven manual page-corner write sites now route through
    `setActiveManualPageContour(state, …, isPerFrameModeActive())`:
    `updateManualPageCorner` (corner drag), `seedDefaultManualPageContour` (the
    inset-rectangle seed when detection fails), and `clearPageCornerEdits` (the
    `null` clear). Each preserves its existing `rawPageContour` / `pageQuadSource`
    bookkeeping verbatim. The `clearAllPreviews` reset (start-of-load) was left as a
    direct legacy `= null` on purpose: it is a global preview reset that runs while
    the `images[]` array is about to be rebuilt, not a per-image edit.
  - Post-Rotation: `readPostRotationSliderDeg()` (clamped slider read, factored from
    the existing duplicated clamp) and `commitActivePostRotationFromSlider()` were
    added. The latter writes the slider value onto the active entry **only** in
    per-frame mode and is wired into the Post-Rotation slider's `change` handler in
    `ui-controls.js` (before `scheduleProcess()`, after the unchanged-scrub early
    return). In markers/markerless mode it early-returns, so the legacy slider →
    `config.postRotationDeg` → pipeline path is byte-for-byte unchanged.
  - New `setActiveImage(index)` performs the active-image switch as **UI
    navigation, not a config change**: it calls `setActiveSourceImage`, repoints the
    legacy projections (`canvas`, `image`, `filename`, `mimeType`, `dragUrl`) at the
    new entry, restores that entry's `manualPageContour` into the legacy field +
    overlay `rawPageContour` (or clears them), drops any stale live threshold
    preview, restores the entry's `postRotationDeg` onto the slider
    (`dom.postRotation.value` + `updateSliderReadouts()`), refreshes the raw-photo
    heading/credit, and calls `renderRawPreview()`. It deliberately does **not**
    call `scheduleProcess()` — the existing composite/animation stays live until a
    real config change. It is exposed as `window.plottimation.setActiveImage` so it
    can be exercised before the Phase 7 strip exists (the dev-console
    `activeImageIndex = …; renderRawPreview()` route still works but won't restore
    the slider/contour; prefer `setActiveImage`).
- `js/ui-controls.js`: added `commitActivePostRotationFromSlider` to the `attachUi`
  deps (JSDoc + destructure) and called it in the Post-Rotation `change` handler.
  No other listeners changed.
- `js/dom-state.js`: **not touched** — the per-image `manualPageContour` /
  `postRotationDeg` fields and `state.runtime.forcePerFrameMode` already exist from
  Phases 2–4, so the plan's listing of `dom-state.js` for Phase 5 was a no-op.
- No Mats allocated, no i18n strings added, Page Detection Threshold stayed global.
- **Notes for later phases:** (6) Phase 6 makes `dom.alignmentPipelinePerFrame`
  real; `isPerFrameModeActive()` already prefers it, so no app.js change is needed
  there for detection. (7) The strip should call `setActiveImage(index)` on
  thumbnail click (do not poke `state.source.activeImageIndex` directly — that skips
  the slider/contour restore); after reorder/delete it should re-derive the active
  index and call `setActiveImage` before reprocessing. (8) Settings load must
  populate each entry's `manualPageContour` / `postRotationDeg`; for the active
  entry it should also refresh the legacy field + slider (or just call
  `setActiveImage(activeImageIndex)` afterwards) so the editor reflects the restored
  values. The post-rotation scrub *preview* (Panel 3 live rotation) is still
  markerless-gated (`config.alignmentPipeline !== "markerless"` skips it), so in
  per-frame mode the slider commits on `change` but does not show a live scrub
  preview — wiring that for per-frame is left as later polish.

---

### Phase 6 — `alignmentPipeline` radio: add "per-frame"

**Goal:** expose per-frame mode via the existing Alignment Pipeline radio group
and wire mode-gated visibility.

**Scope:**
- `index.html`: add a third radio
  `#alignmentPipelinePerFrame` to `#alignmentPipelineField`.
- `js/dom-state.js`: add the DOM ref.
- `js/settings-defaults.js`: leave default as `"markers"`; add a sync line for
  the new radio.
- `js/ui-controls.js`: add to the change listeners; on switch into per-frame
  mode with `state.source.images.length === 0`, do not process; just wait for
  upload.
- `js/app.js → readConfig`: emit `"per-frame"` when the new radio is checked
  (already stubbed in Phase 3; this phase makes the radio real).
- Mode-gated visibility (audit and update):
  - **Disabled in per-frame mode:** all marker controls, all markerless gutter
    controls, Grid Edge Threshold, Grid Edge Run Length, marker editor,
    Rectified Grid `Pre`/`Post` toggle, Page Detection Threshold's "live
    preview" semantics (still functional but global).
  - **Enabled in per-frame mode:** stabilization (Neighbor / Median both work),
    Vertical Drift Compensation, Frame Corners overrides, ordering, appearance,
    export options, Layout's Frame Rows/Cols (display-only).
- `js/i18n.js`: new strings for the radio label, tooltip, and any mode-gated UI
  labels that diverge.
- Audit every `alignmentPipeline === "markerless"` site (≈30 in `app.js`) and
  classify:
  - **"markerless-only behavior"**: stays as `=== "markerless"`. Examples:
    markerless gutter chart, markerless phase debug, autocorrelation.
  - **"non-marker behavior"**: change to `!== "markers"` so per-frame inherits.
    Examples: stabilization availability, drift comp UI.
  - **"per-frame-disabled"**: add `&& alignmentPipeline !== "per-frame"` guard.
    Examples: Rectified Grid Pre/Post toggle visibility.

  Produce a checklist file (or inline TODO list) during this phase listing each
  classification decision; it makes the code review tractable.

**Files touched:**
- `index.html`
- `js/dom-state.js`
- `js/settings-defaults.js`
- `js/ui-controls.js`
- `js/app.js`
- `js/i18n.js`

**Acceptance:**
- Switching the radio between all three modes works without errors.
- Per-frame mode hides marker/markerless-specific UI cleanly (no orphan labels,
  no flashed empty panels).
- Markers and markerless modes still pass demo round-trips.
- Mobile single-viewer mode still behaves correctly across all three pipelines.

**Out of scope:**
- The image strip itself (Phase 7).
- Settings persistence (Phase 8).

**As built (Phase 6 — COMPLETE):**

*New radio + DOM/i18n wiring*
- `index.html`: added a third radio `#alignmentPipelinePerFrame` (`name="alignmentPipeline"`,
  `value="per-frame"`) to `#alignmentPipelineField`, with a `<span data-i18n="alignment.pipelineOptions.perFrame">`
  label matching the two siblings.
- `js/dom-state.js`: added `alignmentPipelinePerFrame: q("#alignmentPipelinePerFrame")` to the
  `alignment` group (auto-flattened to `dom.alignmentPipelinePerFrame`). No new container refs were
  needed — visibility is gated entirely through the existing alignment rows plus a new body class.
- `js/settings-defaults.js`: default stays `"markers"`. `applyNonLayoutDefaults` now also sets
  `dom.alignmentPipelinePerFrame.checked = (default === "per-frame")` (guarded by existence), so
  reset/sync drives all three radios consistently.
- `js/ui-controls.js`: the per-frame radio joins the `attachAlignmentPipelineControls` `input`/`change`
  listeners (`.filter(Boolean)` so a missing ref is harmless). Switching into per-frame with no images
  loaded does NOT process — `scheduleProcess` already no-ops when `state.source.image` is null (the
  empty-`images[]` case), so the handler just waits for upload. The handler also calls
  `reconcilePerFrameForceFlag()` which sets `state.runtime.forcePerFrameMode` to the per-frame radio's
  checked state, so once the user interacts with the radio it becomes authoritative and switching
  *out* of per-frame after a multi-image load actually sticks (the Phase 4 shim no longer pins the
  mode). `attachAlignmentPipelineControls` gained `state` in its deps for this.
- `js/app.js`: `readConfig`/`isPerFrameModeActive` already emit `"per-frame"` from Phase 5; verified
  they now resolve through the real radio. `getActiveAlignmentPipeline()` now returns `"per-frame"`
  when `isPerFrameModeActive()` (else markerless/markers as before). `resetNonLayoutControls` clears
  `state.runtime.forcePerFrameMode = false` so a reset truly returns to the default markers pipeline.

*Mode flags (new in `getAlignmentUiModeFlags`)*
- `showMarkerlessControls` (`=== "markerless"`) — unchanged, strictly markerless-only.
- `showMarkersPipelineControls` (`=== "markers"`) — unchanged.
- `showCrossOnlyControls` — unchanged (markers + cross marker type).
- `showFrameCornerControls` (`!== "markers"`) — NEW: the shared non-marker family (markerless +
  per-frame) for stabilization, drift compensation, Frame Corners labels/slider/tooltips.
- `isPerFrame` (`=== "per-frame"`) — NEW: drives the per-frame drop note and the
  `per-frame-pipeline` body class.
- Body classes: `markerless-pipeline` (unchanged) plus new `per-frame-pipeline`. `style.css`
  extended the markerless flat-background viewport selectors to also match `per-frame-pipeline` (the
  Frame Corners + preview viewports), preventing a checkerboard mismatch in per-frame mode. (Note:
  `style.css` was not in the Phase 6 file list; this is a 2-line additive selector only.)

*New i18n keys (added to ALL 13 locale tables; same locale set as Phase 4's `photo.dropNotePerFrame`)*
- `alignment.pipelineOptions.perFrame` — the radio label (locale-translated in all 13 tables).
- `tooltip.alignmentPipelinePerFrame` — the radio tooltip (locale-translated in all 13 tables),
  plus a `TOOLTIP_SELECTOR_KEYS` entry `"#alignmentPipelinePerFrame": ["alignmentPipelinePerFrame",
  "alignmentPipelineField"]`.
- The per-frame drop note reuses the existing `photo.dropNotePerFrame` (added in Phase 4); no new
  drop-note key was needed. `syncAlignmentPipelineLabels` now shows `photo.dropNotePerFrame` when
  `isPerFrame`, else `photo.dropNote`.
- Verified: `perFrame: "` appears 13×, `alignmentPipelinePerFrame` appears 14× (13 tooltip values +
  1 selector key), `dropNotePerFrame` appears 13×.

*Classification checklist — every `alignmentPipeline === "markerless"` / `!== "markerless"` site
audited in `js/app.js` (line numbers approximate, post-edit).* Reclassification preserves
byte-identical behavior for markers and markerless: for markerless, `!== "markers"` ≡ old
`=== "markerless"` (true) and `=== "markers"` ≡ old `!== "markerless"` (false); only per-frame newly
joins the non-marker branch.

| Site | Function | Old guard | Classification | New guard |
|------|----------|-----------|----------------|-----------|
| ~1111 | inverted marker vision | `=== "markers"` | markers-only (untouched) | `=== "markers"` |
| ~2100 | `applyManualMarkerOverrides` | `=== "markerless"` return | non-marker (skip in-place marker patch) | `!== "markers"` |
| ~2405 | `beginStabilizationStrengthScrub` | `=== "markerless"` warmup | non-marker (stabilization shared) | `!== "markers"` |
| ~3688 | `toggleMarkerlessPhaseDebug` | `!== "markerless"` return | **markerless-only** (phase debug) | unchanged |
| ~3717 | `toggleMarkerlessWorkingImage` | `!== "markerless"` return | **markerless-only** (working-image debug) | unchanged |
| ~3749 | `clearMarkerEdits` (`usesCornerNudges`) | `=== "markerless"` | non-marker (corner-nudge revert path) | `!== "markers"` |
| ~3945 | `updateSliderReadouts` ROI estimate | `=== "markerless"` | non-marker (corner-tile estimate) | `!== "markers"` |
| ~4355 | post-process stabilization warmup | `=== "markerless"` | non-marker (warm stabilization for per-frame) | `!== "markers"` |
| ~4434 | `renderRectifiedPreview` working canvas | `=== "markerless"` | **markerless-only** (working-blur canvas) | unchanged |
| ~4560 | grid-search-inset overlay | `=== "markerless"` | **markerless-only** (search-inset visual) | unchanged |
| ~4603 | markerless phase-debug chart | `=== "markerless"` | **markerless-only** (phase debug viz) | unchanged |
| ~4894 | `getPreviewFrameQuadForSourceIndex` | `=== "markerless"` | non-marker (corner-lattice extraction) | `!== "markers"` |
| ~4980 | `resolveDisplayedAlignmentPoint` | `=== "markerless"` | non-marker (corner display model) | `!== "markers"` |
| ~5655 | `getFrameExtractionAlignmentInfo` | `=== "markerless"` | non-marker (extraction lattice; phase=0 in per-frame) | `!== "markers"` |
| ~6146 | `scheduleCurrentStabilizationWarmup` | `!== "markerless"` return | non-marker (stabilization shared) | `=== "markers"` |
| ~6748 | `getMarkerlessPhaseSourceOffset` | `!== "markerless"` → {0,0} | **markerless-only** (per-frame has no phase sweep; returns 0) | unchanged |
| ~6790 | `getMarkerlessVerticalDriftSourceOffset` | `!== "markerless"` → {0,0} | non-marker (Vertical Drift Compensation enabled) | `=== "markers"` |
| ~6840 | `getMarkerlessCornerStabilizationOffset` | `!== "markerless"` → {0,0} | non-marker (stabilization + Frame Corners) | `=== "markers"` |
| ~6903 | `getMarkerlessCornerManualNudge` | `!== "markerless"` → {0,0} | non-marker (Frame Corners overrides) | `=== "markers"` |
| ~7156 | `getDisplayAlignmentInfo` early return | `!== "markerless" && !preview` | non-marker (markers-only short-circuit) | `=== "markers" && !preview` |
| ~7164 | `getDisplayAlignmentInfo` marker post-rot branch | `!== "markerless"` | non-marker (markers-only marker preview; per-frame falls to corner builder) | `=== "markers"` |
| ~7712 | `applyMarkerOverride` (`usesCornerNudges`) | `=== "markerless"` | non-marker (corner-nudge override semantics) | `!== "markers"` |
| ~7781 | `restoreMarkerOverride` (`usesCornerNudges`) | `=== "markerless"` | non-marker (corner-nudge clear path) | `!== "markers"` |
| (n/a) | `getPageBoundaryPreviewSignature` (~7211) | `config.alignmentPipeline` in cache key | passthrough (per-frame yields distinct signature naturally) | unchanged |
| (n/a) | `syncAlignmentMarkerUi` working-image reset | `pipeline !== "markerless"` | **markerless-only** (resets working-image flag; correct for per-frame) | unchanged |

*Visibility audit (`syncAlignmentPipelineVisibility`, label/slider/tooltip syncs)*
- **Disabled in per-frame** (hidden): Grid Edge Threshold (`boundarySensitivityRow`) and Grid Edge
  Run Length (`boundaryPersistenceRow`) changed `hidden = showMarkerlessControls` →
  `hidden = !showMarkersPipelineControls` (marker-grid-only, so hidden in markerless AND per-frame);
  marker-type field (`alignmentMarkerTypeField`, already markers-only); markerless gutter/phase
  sliders (`markerlessPhaseXRow`/`markerlessPhaseYRow`, kept `!showMarkerlessControls`); the
  Rectified Grid Pre/Post (`Rectified Grid` toggle) is not pipeline-radio-gated here — the marker
  editor's blob view (`toggleMarkerBlobViewButton`) is already always hidden.
- **Enabled in per-frame** (visible via `showFrameCornerControls`): stabilization method group +
  enable + strength + lambda rows (Neighbor / Median both work); Vertical Drift Compensation row;
  ROI-size slider position (`syncAlignmentSliderOrder`); Frame Corners override editor
  (`toggleMarkerEditingButton`/`clearMarkerEditsButton` — not pipeline-gated, inherits markerless
  behavior via the `usesCornerNudges` override sites above). `syncStabilizationMethodUi` lambda
  gating moved to `showFrameCornerControls`.
- **Labels/tooltips**: `syncAlignmentPipelineLabels` uses `showFrameCornerControls` for the Frame
  Corners heading, the Centers/Stabilize viewer + mobile-control tab labels, and the ROI-size label
  (so per-frame reads "Frame Corners"/"Centers"/"Stabilize", not marker wording);
  `showMarkerlessControls` is still used only for the gutter-specific `summaryMarkerless` copy.
  `syncAlignmentModeTooltips` now takes `showFrameCornerControls`. Drop note uses `isPerFrame ?
  dropNotePerFrame : dropNote`.

*Mobile checkpoint:* viewer tabs and mobile control tabs are always present (not pipeline-gated);
only their text changes, now via `showFrameCornerControls`, so per-frame shows Centers/Stabilize on
mobile single-viewer just like markerless. No viewer-tab visibility branch keys off pipeline mode, so
all three pipelines work in mobile single-viewer mode.

*Mat lifetime:* Phase 6 allocates no OpenCV Mats (UI-only). No `.delete()` changes.

*Validation:* `node --check` passes on `js/app.js`, `js/ui-controls.js`, `js/dom-state.js`,
`js/settings-defaults.js`, `js/i18n.js`. i18n key counts verified (see above). Markers/markerless
conditionals confirmed byte-identical by the `markers`/`markerless` truth-table above.

*Notes for Phases 7–9:*
- (7) The strip should call `setActiveImage(index)` (Phase 5) on thumbnail click and re-derive the
  active index after reorder/delete. Strip visibility can key off the `per-frame-pipeline` body class
  or `isPerFrameModeActive()`. The strip belongs in the Photo group; nothing in Phase 6 reserved a
  container, so Phase 7 adds its own (`#perFrameStripPanel`) and DOM refs.
- (8) Settings load currently still routes `alignment_pipeline = per-frame` through
  `settings-io.js`'s markers/markerless branch (lines ~147-151) — **left untouched on purpose**
  (Phase 8 owns per-frame settings round-trip). When Phase 8 lands, that load branch must recognize
  `per-frame` and set `dom.alignmentPipelinePerFrame.checked` + `state.runtime.forcePerFrameMode`
  rather than falling back to markerless. Save side already emits `config.alignmentPipeline`
  (`per-frame`) correctly.
- (9) Per-frame's post-rotation live scrub preview is still markerless-gated (Phase 5 note); wiring a
  per-frame scrub preview is later polish. No memory work was added here (Phase 9 owns the cell-size
  ceiling and per-image cache trimming).

---

### Phase 7 — Image strip UI

**Goal:** give the user a visible way to switch active image, see upload count,
reorder, and delete.

**Scope:**
- New section in `index.html`, visible only in per-frame mode. Likely placed
  inside the Photo control group below the drop zone, or as a new collapsible
  `#perFrameStripPanel`.
- Renders a horizontal scrollable strip of thumbnails (one per
  `state.source.images[i]`). Each thumbnail shows:
  - the image (small preview, square-cropped or letterboxed)
  - the frame number `1`, `2`, …
  - a delete (×) button on hover
  - active state highlighting
- Drag-to-reorder within the strip (HTML5 drag-and-drop API, scoped to the
  strip).
- Click selects active image.
- A `+` tile at the end accepts additional dropped or chosen images.
- New file `js/per-frame-strip.js` keeps strip rendering / event handling out of
  `app.js` and `ui-controls.js`.
- Mobile: the strip should still be usable in single-viewer mode. The strip can
  appear above the active raw photo viewer.
- Reorder triggers reprocessing (frame order changes).
- Delete triggers reprocessing.

**Files touched:**
- `index.html`
- `js/dom-state.js` (strip DOM refs)
- `js/ui-controls.js` (wire-up)
- new `js/per-frame-strip.js`
- `style.css` (strip + thumbnail styling)
- `js/i18n.js`

**Acceptance:**
- Upload 5 images, reorder them, the animation reflects the new order on next
  preview tick.
- Delete an image; the animation rebuilds with N-1 frames.
- Active-image highlighting matches `state.source.activeImageIndex`.
- Mobile: strip is reachable and usable in the Page viewer tab.

**Out of scope:**
- Cross-strip drag (e.g. dragging a thumbnail out of the app).
- Bulk operations (multi-select delete).

**As built (Phase 7 — COMPLETE):**

*New module `js/per-frame-strip.js`* — exports `attachPerFrameStrip(deps)` and
`renderPerFrameStrip()`.
- `attachPerFrameStrip({ dom, state, setActiveImage, reprocess, addImageFiles,
  isPerFrameModeActive })` binds deps in module scope (single instance) and wires the hidden
  `#perFrameStripFileInput` `change` handler (the `+` tile's file picker). Called once from
  `attachUi`.
- `renderPerFrameStrip()` rebuilds the strip. It hides + empties the panel (sets `panel.hidden =
  true`, clears children, resets the cached signature) whenever `isPerFrameModeActive()` is false, so
  markers/markerless modes never see strip markup. When active it diffs a cheap signature
  (`activeImageIndex | length | per-entry-canvas-presence`) against the last render and early-returns
  when nothing visible changed, to avoid DOM thrash/flicker. Reorder and delete reset the cached
  signature to `""` first so a same-length reorder still rebuilds in the new order.
- Each thumbnail shows the entry image (`<img>` from `entry.dragUrl`, `object-fit: cover` square
  crop), the 1-based frame number, and a hover/focus delete (`×`) button. The trailing `+` tile opens
  the file picker and also accepts image drops directly. Click selects active via the app's
  `setActiveImage(index)` (NO reprocess). Reorder uses HTML5 DnD scoped to the strip (a module-level
  `dragSourceIndex` recorded on `dragstart`; file drags fall through to the add tile). Reorder splices
  `state.source.images[]`, keeps the same logical entry active (re-derives its new index via
  `images.indexOf(activeEntry)` and calls `setActiveImage`), then calls `reprocess()`. Delete splices
  the entry, releases it (see below), clamps the active index toward the prior neighbor, calls
  `setActiveImage`, then `reprocess()`; deleting the last image nulls `state.source.image` and leaves
  only the `+` tile (empty state).

*Delete release path (no leaks):* the strip's `releaseEntry(entry)` revokes `entry.ownedObjectUrl`,
calls the existing `releaseEntryRectifiedCache(entry)` from `js/source-images.js` (frees a bare `Mat`
or a `{ visionMat, styledMat }` cache), and nulls `entry.image` / `entry.canvas`. Active index is
re-clamped via `setActiveSourceImage` (through `setActiveImage`) so it always stays in range.

*Reprocess vs select:* selecting an image routes through the app's `setActiveImage` (Phase 5) → no
`scheduleProcess`. Reorder and delete both call the `reprocess` dep, which is the app's existing
`scheduleProcess` (debounced reprocess entry point). `scheduleProcess` no-ops when `state.source.image`
is null, so deleting the last frame does not reprocess (stale preview lingers until images are
re-added — acceptable empty state).

*`js/app.js`:* added `addPerFrameImages(files)` — decodes each image via the exported
`decodeImageElement` (Phase 4), builds an entry with its own blob URL + source canvas via
`createSourceImageEntry` + `drawImageToCanvas`, pushes to `state.source.images`, forces per-frame mode
on (`forcePerFrameMode` + ticks the radio), adopts entry 0 as active via `setActiveImage` when the
strip started empty, then `syncAlignmentMarkerUi()` + `renderPerFrameStrip()` + `scheduleProcess(0)`.
`renderPerFrameStrip()` is now also called at the tail of `syncAlignmentMarkerUi()` (covers mode
switch / post-process visibility) and at the tail of `setActiveImage()` (active-highlight refresh).
`setActiveImage`, `isPerFrameModeActive`, and `addPerFrameImages` are threaded into `wireUiControls`.
`decodeImageElement` is now exported from `js/load-controller.js`.

*`js/ui-controls.js`:* imports `attachPerFrameStrip` and calls it near the top of `attachUi`, passing
`reprocess: scheduleProcess` and `addImageFiles: addPerFrameImages`. The three new deps
(`setActiveImage`, `isPerFrameModeActive`, `addPerFrameImages`) were added to the `attachUi` JSDoc +
destructure.

*`index.html`:* `#perFrameStripPanel` (a `<section hidden>` inside the Photo control group, below the
drop zone) containing `#perFrameStripHeading` (`data-i18n="photo.strip.heading"`),
`#perFrameStripCount` (frame-count readout), `#perFrameStrip` (`role="list"` thumbnail container), and
a hidden `#perFrameStripFileInput`.

*`js/dom-state.js`:* new `perFrameStrip` group → `dom.perFrameStripPanel`, `dom.perFrameStripHeading`,
`dom.perFrameStripCount`, `dom.perFrameStrip`, `dom.perFrameStripFileInput`.

*`style.css` (additive):* `.per-frame-strip-panel` (hidden in non-per-frame via
`body:not(.per-frame-pipeline) .per-frame-strip-panel { display:none }`), `.per-frame-strip-head`,
`.per-frame-strip-heading`, `.per-frame-strip-count`, `.per-frame-strip` (horizontal scroll),
`.per-frame-thumb` (+ `.is-active`, `.is-drag-over`, `.is-dragging`), `.per-frame-thumb img`,
`.per-frame-thumb-number`, `.per-frame-thumb-delete` (hover/focus reveal), `.per-frame-thumb-add`.
Reuses existing tokens (`--accent`, `--accent-soft`, `--line`, `--radius`, `--muted`,
`--panel-strong`, `--panel`).

*`js/i18n.js`:* new `photo.strip` subgroup added to **all 13** locale tables, keys: `heading`,
`frameCount` (`{count}` plural), `frameCountOne` (singular), `addLabel`, `deleteLabel` (`{index}`),
`selectLabel` (`{index}`). Localized where straightforward, English elsewhere; every table has all 6
keys (verified 13× each).

*Visibility / legacy safety:* the strip is triple-guarded — HTML `hidden` default, CSS body-class
gate, and JS `panel.hidden` toggle keyed off `isPerFrameModeActive()`. Markers/markerless flows are
untouched (the strip is hidden + emptied there and no legacy wiring changed).

*Mobile:* the strip lives in the Photo control group (not the viewer), is horizontally scrollable, and
does not alter the mobile single-viewer layout; it is reachable from the control panel in all modes
but only rendered in per-frame mode.

*Mat lifetime:* the strip allocates no OpenCV Mats; deletes route through `releaseEntryRectifiedCache`.

*Validation:* `node --check` passes on `js/per-frame-strip.js`, `js/app.js`, `js/ui-controls.js`,
`js/dom-state.js`, `js/i18n.js`, `js/load-controller.js`. i18n key counts verified 13× per key.

*Notes for Phases 8–9:* (8) Settings load that restores per-image overrides should call
`renderPerFrameStrip()` (or `setActiveImage(activeImageIndex)`, which calls it) after applying buffered
overrides so the strip reflects restored state; the strip already re-renders via `syncAlignmentMarkerUi`
after processing. (9) The empty-after-delete state currently keeps the prior preview because
`scheduleProcess` no-ops with no source image — Phase 9 polish could explicitly clear previews there.
`addPerFrameImages` does not yet enforce the cell-size/large-image ceiling (Phase 9 owns memory
bounding); thumbnails use `entry.dragUrl` directly (full-res blob in an `<img>` scaled by CSS) rather
than downscaled thumbnails — fine for typical counts, but Phase 9 may want true thumbnail generation
for very large/many images.

---

### Phase 8 — Settings persistence for per-image state

**Goal:** make `_settings.txt` round-trip in per-frame mode.

**Scope:**
- `js/settings-io.js` — save side:
  - Emit `alignment_pipeline = per-frame`.
  - For each image `i = 0 … N-1`:
    - `page_corner_override_tl_i`, `_tr_i`, `_br_i`, `_bl_i` (only if that image
      has overrides; otherwise omit).
    - `per_frame_post_rotation_deg_i` (only if non-zero).
  - Emit `per_frame_image_count = N` so reload knows how many to expect.
- `js/settings-io.js` — load side:
  - Recognize `per_frame_image_count` to size the per-image override array
    before images themselves load.
  - On image load (single image first, additional images added later), apply the
    matching indexed overrides to the corresponding `state.source.images[i]`.
  - Backward-compat: legacy files without `per_frame_*` keys load with empty
    per-image overrides.
- Loading a saved per-frame project requires the user to re-upload all N images
  (we cannot save image data in the settings file). On load with no images yet,
  the saved per-image overrides are buffered into a pending structure and
  applied as images arrive (matching by upload order — index 0 → first uploaded
  image). Document this clearly in `documentation.md`.

**Files touched:**
- `js/settings-io.js`
- `js/dom-state.js` (pending overrides buffer)
- `js/load-controller.js` (apply pending overrides as images arrive)
- `documentation.md`

**Acceptance:**
- Edit per-image corners + post-rotation across 3 images; save settings; reload
  the page; re-upload the same 3 images; per-image overrides reappear correctly.
- Legacy `_settings.txt` files (markers / markerless) still load without
  regression.
- The saved file remains a TSV that humans can inspect.

**Out of scope:**
- Saving image data inside the settings file.
- Auto-matching by filename across reloads (matching is strictly by upload
  order in v1).

**As built (Phase 8 — COMPLETE):**

*Save side (`js/settings-io.js → buildSettingsTsv`)*
- `buildSettingsTsv` gained an additive `perImageEntries` param (default `null`; JSDoc updated). The
  per-frame rows are appended **only** when `config.alignmentPipeline === "per-frame"` and
  `perImageEntries` is an array, so markers/markerless saves stay byte-identical (the param is passed
  unconditionally by the caller but ignored outside per-frame mode).
- Emitted keys (exact names / formats, appended after the page-corner-override and marker-override
  rows):
  - `per_frame_image_count<TAB>N` — always emitted in per-frame mode (e.g. `per_frame_image_count\t3`).
  - `page_corner_override_tl_{i}` / `_tr_{i}` / `_br_{i}` / `_bl_{i}` — emitted as a set of four **only**
    when image `i` has a valid 4-point `manualPageContour`; reuses the exact single-image
    `page_corner_override_*` serialization (`${point.x},${point.y}`) suffixed with `_${i}` (e.g.
    `page_corner_override_tl_1\t1,2`). Images without an override emit nothing.
  - `per_frame_post_rotation_deg_{i}<TAB>deg` — emitted **only** when image `i`'s `postRotationDeg` is
    a finite non-zero number (e.g. `per_frame_post_rotation_deg_2\t5`).
  - `alignment_pipeline\tper-frame` is emitted by the pre-existing `["alignment_pipeline",
    String(config.alignmentPipeline)]` row (verified — no change needed).
- Caller `js/app.js → buildSettingsTsv(config)` now passes `perImageEntries: state.source.images`.

*Load side (`js/settings-io.js → applyLoadedSettingsText` + new `parsePerImageOverrides`)*
- `state.source.pendingPerImageOverrides` is reset to `null` at the top of every load (so a markers
  file loaded after a per-frame file leaves no stale buffer).
- Pipeline selection reconciled: `usePerFramePipeline = (pipeline === "per-frame")`. When true:
  `dom.alignmentPipelinePerFrame.checked = true`, `dom.alignmentPipelineMarkerless.checked = false`,
  `dom.alignmentPipelineMarkers.checked = false`, and `state.runtime.forcePerFrameMode = true` (mirrors
  Phase 6's change-listener so radio + flag never diverge). `useMarkerlessPipeline` now also requires
  `!usePerFramePipeline`, and `markers = !markerless && !perFrame`. For markers/markerless files the
  truth table is unchanged (`perFrame` false), so legacy selection does not regress. The
  `dom.alignmentPipelinePerFrame` write is existence-guarded for older DOMs.
- New `parsePerImageOverrides(entries)` reads `per_frame_image_count` (floored, `>0`, else `0`) and for
  each index `i` collects the four `page_corner_override_*_{i}` rows (only when all four present and
  every point parses) and the optional `per_frame_post_rotation_deg_{i}`. Returns
  `{ count, overrides }` where each `overrides[i]` is `{ manualPageContour, postRotationDeg }` or `null`
  when image `i` had no saved override of either kind. Called **only** in the per-frame branch; legacy
  files leave the buffer `null`.

*Pending buffer (`js/dom-state.js`)*
- `state.source.pendingPerImageOverrides` added (default `null`). Shape:
  `{ count: number, overrides: Array<{ manualPageContour: {x,y}[] | null, postRotationDeg: number } | null> } | null`.
  `null` = no pending restore (legacy/markers/markerless). Documented inline in `dom-state.js`. It holds
  parsed-but-not-yet-applied overrides because a saved project cannot embed image data — the user must
  re-upload the same N images in the same order.

*Apply-on-arrival (`js/load-controller.js`)*
- New exported `applyPendingPerImageOverrides(state)` iterates `state.source.images` and, by upload-order
  index, copies each non-null buffered override onto `images[i].manualPageContour` (deep-copied points)
  and `images[i].postRotationDeg`, then sets `state.source.pendingPerImageOverrides = null` (consume) and
  returns `true` if a buffer was present (else `false`).
- `loadImageSource`'s `image.onload` calls it right after `applyLoadedSettingsText` (so the buffer is
  fresh) and after the legacy `sourceEntry.manualPageContour` mirror; only when it returns `true` does it
  call the new `refreshActiveImage?.(activeImageIndex)` dep (= app.js `setActiveImage`) to refresh the
  active entry's legacy field + Post-Rotation slider + Page Corners overlay + strip. Gating on the return
  value keeps single-image markers/markerless loads untouched (no `setActiveImage` side effects there).
- `js/app.js` threads `refreshActiveImage: setActiveImage` into `loadImageSourceViaController`, imports
  `applyPendingPerImageOverrides`, and also calls it in `addPerFrameImages` (the strip `+` tile / lone
  settings-file-then-upload path) so a settings file loaded before any images still reattaches its
  buffered overrides when images arrive via the strip; `setActiveImage(0)` (run when the strip started
  empty) then refreshes the editor.
- Consume/clear is verified: a second `applyPendingPerImageOverrides` call returns `false` and mutates
  nothing, so re-loading images later never reapplies stale overrides.

*`documentation.md`*
- Added the per-image keys to the "stored settings" list and a new "Reloading a per-frame project"
  subsection under Sibling Settings Files: settings files contain no image data; to restore a saved
  per-frame project the user re-uploads the **same images in the same order**, and buffered per-image
  overrides reattach strictly by upload order (no filename matching).

*Validation*
- `node --check` passes on `js/settings-io.js`, `js/dom-state.js`, `js/load-controller.js`, `js/app.js`.
- Round-trip traced + script-verified: per-frame mode, 3 images, image #2 corners + image #3
  post-rotation → SAVE emits exactly `per_frame_image_count\t3`, `page_corner_override_{tl,tr,br,bl}_1`,
  `per_frame_post_rotation_deg_2\t5` (nothing for image 0) → LOAD sets `forcePerFrameMode=true` and a
  buffer `{count:3, overrides:[null, {contour}, {postRotationDeg:5}]}` → apply reattaches to the right
  entries and clears the buffer (second apply is a no-op).
- Legacy markers file traced + script-verified: `forcePerFrameMode=false`, buffer stays `null`, no
  per-frame path triggered, selection unchanged.

*Notes for Phase 9*
- No Mats allocated, no i18n strings added (settings keys are not localized).
- Matching is strictly by upload order (no filename matching) — a deliberately deferred item.
- The empty-after-delete preview-clear and the cell-size/large-image memory ceiling remain Phase 9 work;
  Phase 8 added no memory bounding. AGENTS.md/llm_readme invariants (incl. the per-frame settings
  round-trip invariant) are Phase 9 scope and were intentionally NOT added here.

---

### Phase 9 — Memory and polish

**Goal:** make per-frame mode safe on large inputs, finish documentation, and
write the AGENTS.md invariants.

**Scope:**
- `js/app.js → trimCachesBeforeReprocess`: release any per-image rectified Mat
  cache entries that are not the active image. The composite `baseRectifiedMat`
  is the only large Mat that needs to stay live between reprocesses.
- `js/pipeline.js → runPerFramePipeline`: bound the cell size such that
  `cellW × N × cellH` cannot exceed the same memory ceiling that the existing
  large-image path uses for `pageSizeHigh`. If the median would exceed the
  ceiling, scale the cell size down uniformly.
- Mobile single-viewer audit: confirm the Page tab works with the new strip and
  active-image switching.
- `documentation.md`: add a "Per-Frame Pipeline" section explaining when to use
  it, how to upload multiple images, per-image page-corner editing, and the
  reload story for saved settings.
- `AGENTS.md`: add invariants:
  - Per-image page-corner overrides are post-load, pre-rectification. They feed
    into `rectifySinglePage` for that image only.
  - Active-image switching is a UI navigation and does NOT trigger reprocessing.
  - Per-frame mode disables marker and markerless-specific controls.
  - Per-frame `_settings.txt` round-trip requires re-uploading images in the
    same order.
- `llm_readme.md`: add a "Per-Frame Pipeline" section that mirrors the marker /
  markerless sections and points back to this plan.

**Files touched:**
- `js/app.js`
- `js/pipeline.js`
- `documentation.md`
- `AGENTS.md`
- `llm_readme.md`

**Acceptance:**
- Loading 20 images at 4000×3000 each does not crash the tab (cell size scaled
  down).
- Switching active image is instant (no reprocessing).
- Mobile UX is acceptable.
- Documentation is current and the AGENTS.md invariants are stated.

**Out of scope:**
- New features beyond what Phases 0–8 added.

**As built (Phase 9 — COMPLETE):**

*Composite-area memory ceiling (`js/pipeline.js → runPerFramePipeline`)*
- New constant `PER_FRAME_COMPOSITE_AREA_CEILING_PX = RECTIFIED_PREVIEW_LONG_EDGE_PX *
  RECTIFIED_PREVIEW_LONG_EDGE_PX` (= 2200² = 4,840,000 px). This is the exact total-area budget the
  single-page path already lives within: `matToPreviewCanvas` caps the rectified preview at
  `RECTIFIED_PREVIEW_LONG_EDGE_PX` on its long edge and the high-res warp is diagonal-capped, so the
  largest single working sheet is bounded by `RECTIFIED_PREVIEW_LONG_EDGE_PX²`. The stacked
  `cellW × N × cellH` composite is held to that same area.
- After the existing per-dimension median clamp (`PER_FRAME_MIN_CELL_PX` 16 / `PER_FRAME_MAX_CELL_PX`
  1600 — unchanged), `cellW`/`cellH` became `let`. When `cellW * cellH * frameCount >`
  the ceiling, `scale = Math.sqrt(ceiling / compositeArea)` is applied to BOTH dimensions
  (`cellW = max(MIN, round(cellW*scale))`, same for `cellH`), so the cell aspect ratio is preserved
  and the whole sheet fits. With N images the cells shrink uniformly; e.g. 20 × 4000×3000 pages
  (median cell clamped to 1600×1200, area 1600·1200·20 = 38.4M ≫ 4.84M) scale by
  `sqrt(4.84M/38.4M) ≈ 0.355` → ~568×426 cells, a ~11.6M-px composite that the tab can hold.
- Mat lifetime unchanged and explicit: `composite`, each per-cell `resized`, and each `roi` are freed
  in their `finally` blocks; the uniform downscale only adjusts two scalars before allocation, so it
  introduces no new Mats and no leak. (Constants + the area-ceiling block were the only edits; this
  finalizes the Phase 3 deferral.)

*Cache trim (`js/app.js → trimCachesBeforeReprocess`)*
- Added `trimInactivePerFrameRectifiedCaches()`, called from `trimCachesBeforeReprocess`. It returns
  immediately unless `state.source.images` is an array of length > 1, then for every index that is NOT
  `state.source.activeImageIndex` it calls `releaseEntryRectifiedCache(images[i])` (the existing helper
  in `js/source-images.js`, which frees a bare `Mat` or a `{ visionMat, styledMat }` cache and resets
  `rectifiedDirty`). It only frees NON-active per-image caches; the active image's cache is kept warm,
  and the composite `baseRectifiedMat` lives on `state.geometry` (not on any per-image entry), so it is
  never touched. No-op for markers/markerless (those modes hold ≤1 entry, so the `length <= 1` guard
  short-circuits).

*Empty-state preview clear (Phase 7 polish item)*
- Deleting the last image in the strip previously left a stale rectified sheet / animation because the
  strip's `reprocess` (= `scheduleProcess`) no-ops with no source image. `js/per-frame-strip.js`'s
  empty-state branch in `deleteImageAt` now calls a new `clearPreviews` dep instead of the no-op
  `reprocess`. `clearPreviews` is wired to the existing, tested `clearAllPreviews()` (threaded
  `app.js → wireUiControls` deps → `ui-controls.js attachUi` → `attachPerFrameStrip`), so the empty
  state blanks the raw canvas and all downstream panels consistently. Low-risk: reuses the same reset
  that runs at the start of every load; markers/markerless never hit this path (strip is per-frame-only).

*Mobile single-viewer audit (read-only; no bug found)*
- The mobile viewer tabs (`raw`/`rectified`/`markers`/`preview`) and their cards are always present;
  their visibility never branches on `alignmentPipeline` (confirmed in `app.js
  syncMobileViewerLayout` — only the tab TEXT changes via `showFrameCornerControls`, per Phase 6). The
  per-frame image strip lives in the Photo *control group* (`#perFrameStripPanel`), not in the viewer
  area, so it does not perturb the single-viewer layout and is reachable via the mobile control tabs.
  The raw/Page tab renders `renderRawPreview()` of the active image, and `setActiveImage` (Phase 5)
  calls `renderRawPreview()` on every active-image switch, so switching images updates the Page tab
  correctly. Conclusion: the Page tab works with the strip and active-image switching as-is — no
  speculative changes made.

*Documentation additions*
- `documentation.md`: new "Per-Frame Pipeline" section (+ TOC entry) covering when to use it, the three
  ways to upload multiple images (drag several / multi-select picker / strip `+` tile), the image strip
  (select = navigation, drag = reorder/reprocess, delete, add), per-image page-corner / post-rotation
  editing on the active image, and a cross-reference to the existing "Reloading a per-frame project"
  subsection (no duplication). The Alignment Pipeline section now says "three workflows" and lists the
  Per-Frame mode.
- `AGENTS.md`: Architecture line updated from "two alignment pipelines" to "three" (adds `Per-frame`);
  the stale "check both pipelines" verification line now reads "all three pipelines". New "Per-Frame
  Notes" block states the durable invariants: per-image overrides are post-load/pre-rectification and
  feed `rectifySinglePage` for that image only; active-image switching is UI navigation and does NOT
  reprocess; per-frame mode disables marker/markerless-specific controls; `_settings.txt` round-trip
  requires re-uploading images in the same order; and the composite cell-size area ceiling.
- `llm_readme.md`: new "Per-Frame" subsection under "Current Pipelines" mirroring Markers/Markerless
  (entry point, per-image rectification, common-cell composite + memory ceiling, synthetic corner
  lattice, strip, settings round-trip) and pointing back to `per_frame_pipeline_plan.md` for the full
  plan; the stale "shared by both pipelines" line under Light-on-dark now reads "by the marker and
  markerless pipelines".

*Validation*
- `node --check` passes on `js/app.js`, `js/pipeline.js`, `js/ui-controls.js`, `js/per-frame-strip.js`.
- Markers/markerless are unaffected: the cache trim and empty-state clear are per-frame-only (guarded
  on `images[]` length / strip-only path), and the pipeline area-ceiling code only runs inside
  `runPerFramePipeline`.
- No new i18n strings were added (Phase 9 was memory + docs only).

*Plan status:* the per-frame alignment pipeline is now fully implemented — Phases 0–9 are all COMPLETE.

---

## Cross-Cutting Invariants (apply across every phase)

- Markers and markerless modes are not allowed to regress at any phase boundary.
  Run a demo round-trip for at least one markers demo and one markerless demo
  before declaring a phase done.
- `_settings.txt` files saved by `main` must still load in every phase up to and
  including Phase 8. Per-image keys are additive.
- Mat lifetime stays explicit. Every new Mat allocation in
  `runPerFramePipeline` has a matching `.delete()` in a `finally` block.
- i18n strings are added to **all** locale tables, not just English.
- Mobile single-viewer mode is checked at Phase 6, Phase 7, and Phase 9.

## Files Touched (cumulative reference)

| File | Phases |
|------|--------|
| `index.html` | 4, 6, 7 |
| `style.css` | 7 |
| `js/dom-state.js` | 2, 6, 7, 8 |
| `js/load-controller.js` | 2, 4, 8 |
| `js/pipeline.js` | 1, 3, 9 |
| `js/app.js` | 3, 5, 6, 9 |
| `js/ui-controls.js` | 5, 6, 7 |
| `js/settings-io.js` | 8 |
| `js/settings-defaults.js` | 6 |
| `js/i18n.js` | 4, 6, 7 |
| `js/per-frame-strip.js` (new) | 7 |
| `js/source-images.js` (new, optional) | 2 |
| `documentation.md` | 8, 9 |
| `AGENTS.md` | 9 |
| `llm_readme.md` | 9 |

## Open Items Deliberately Deferred

- Per-image Page Detection Threshold (v1 keeps it global).
- Auto-matching saved per-image overrides by filename on reload (v1 matches by
  upload order).
- Saving image data inside settings files (out of scope; settings stay text).
- Per-image grid mode (every image as its own 1×1; out of scope — frame count
  equals image count).
