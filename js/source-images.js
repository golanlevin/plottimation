/**
 * Per-image source state helpers.
 *
 * The per-frame alignment pipeline lets the user upload one image per animation frame. To support
 * that without rewriting every legacy caller at once, the canonical per-image data lives in
 * `state.source.images[]` and the existing `state.source.image / canvas / dragUrl / ...` fields are
 * kept as projections of the active entry.
 *
 * During Phase 2 of the per-frame rollout, `state.source.images[]` always holds 0 or 1 entries.
 * Later phases add multi-image upload, per-image overrides, and the strip UI on top of this shape.
 */

/**
 * @typedef {Object} SourceImageEntry
 * @property {HTMLImageElement | null} image Decoded source image element.
 * @property {string} filename Original filename for status text / settings matching.
 * @property {string} mimeType Source MIME type (e.g. `image/jpeg`).
 * @property {string} ownedObjectUrl Blob URL this entry owns and must revoke on release ("" if none).
 * @property {string} dragUrl URL used for raw-photo drag/download (may be a demo path or blob URL).
 * @property {HTMLCanvasElement | null} canvas Source-resolution canvas the CV pipeline reads from.
 * @property {Array<{x:number,y:number}> | null} manualPageContour Per-image source-space page quad override.
 * @property {number} postRotationDeg Per-image Post-Rotation, applied after page rectification.
 * @property {*} rectifiedMatCache Cached rectified Mat (or `{visionMat, styledMat}`); released on clear.
 * @property {boolean} rectifiedDirty Whether the cached rectified Mat must be rebuilt.
 */

/**
 * Build a fresh per-image source entry with sensible defaults.
 *
 * @param {Partial<SourceImageEntry>} [fields={}]
 * @returns {SourceImageEntry}
 */
export function createSourceImageEntry(fields = {}) {
  return {
    image: fields.image ?? null,
    filename: fields.filename ?? "",
    mimeType: fields.mimeType ?? "",
    ownedObjectUrl: fields.ownedObjectUrl ?? "",
    dragUrl: fields.dragUrl ?? "",
    canvas: fields.canvas ?? null,
    manualPageContour: fields.manualPageContour ?? null,
    postRotationDeg: fields.postRotationDeg ?? 0,
    rectifiedMatCache: fields.rectifiedMatCache ?? null,
    rectifiedDirty: fields.rectifiedDirty ?? true,
  };
}

/**
 * Return the active per-image source entry, or `null` when no images are loaded.
 *
 * @param {import("./dom-state.js").state} state
 * @returns {SourceImageEntry | null}
 */
export function getActiveSourceImage(state) {
  const images = state.source.images;
  if (!Array.isArray(images) || images.length === 0) return null;
  const index = state.source.activeImageIndex;
  if (!Number.isInteger(index) || index < 0 || index >= images.length) return null;
  return images[index];
}

/**
 * Set the active per-image index (clamped to the loaded range) and return the new active entry.
 *
 * @param {import("./dom-state.js").state} state
 * @param {number} index
 * @returns {SourceImageEntry | null}
 */
export function setActiveSourceImage(state, index) {
  const images = state.source.images;
  if (!Array.isArray(images) || images.length === 0) {
    state.source.activeImageIndex = 0;
    return null;
  }
  const clamped = Math.max(0, Math.min(Math.trunc(index) || 0, images.length - 1));
  state.source.activeImageIndex = clamped;
  return images[clamped];
}

/**
 * Store a manual page-corner override for the active image.
 *
 * The legacy `state.source.manualPageContour` field is the authoritative input for page detection in
 * markers / markerless modes and is also read by many UI sites (status text, settings save, overlay
 * draw). In per-frame mode the canonical per-image override lives on the active entry, so this helper
 * writes the active entry's `manualPageContour` **and** mirrors to the legacy field so those legacy
 * read sites keep working without per-frame-specific branching. In markers / markerless mode it only
 * writes the legacy field (the per-image array is irrelevant there).
 *
 * @param {import("./dom-state.js").state} state
 * @param {Array<{x:number,y:number}> | null} contour Source-space page quad override, or `null` to clear.
 * @param {boolean} perFrameMode Whether the per-frame pipeline is currently active.
 * @returns {void}
 */
export function setActiveManualPageContour(state, contour, perFrameMode) {
  state.source.manualPageContour = contour;
  if (perFrameMode) {
    const active = getActiveSourceImage(state);
    if (active) active.manualPageContour = contour;
  }
}

/**
 * Store the Post-Rotation value (degrees) for the active image.
 *
 * In per-frame mode each image carries its own Post-Rotation, so this writes the active entry's
 * `postRotationDeg`. In markers / markerless mode Post-Rotation is a single global value applied by
 * the pipeline from `config.postRotationDeg`, so the per-image array is left untouched.
 *
 * @param {import("./dom-state.js").state} state
 * @param {number} deg
 * @param {boolean} perFrameMode Whether the per-frame pipeline is currently active.
 * @returns {void}
 */
export function setActivePostRotationDeg(state, deg, perFrameMode) {
  if (!perFrameMode) return;
  const active = getActiveSourceImage(state);
  if (active) active.postRotationDeg = Number.isFinite(deg) ? deg : 0;
}

/**
 * Release any cached rectified Mat held on a per-image entry.
 *
 * Handles both a bare OpenCV `Mat` and the `{ visionMat, styledMat }` rectified-warp shape produced
 * by `rectifySinglePage`.
 *
 * @param {SourceImageEntry | null | undefined} entry
 * @returns {void}
 */
export function releaseEntryRectifiedCache(entry) {
  if (!entry) return;
  const cache = entry.rectifiedMatCache;
  if (cache) {
    if (typeof cache.delete === "function") {
      try {
        cache.delete();
      } catch {
        /* already freed */
      }
    } else {
      for (const mat of [cache.visionMat, cache.styledMat]) {
        if (mat && typeof mat.delete === "function") {
          try {
            mat.delete();
          } catch {
            /* already freed */
          }
        }
      }
    }
  }
  entry.rectifiedMatCache = null;
  entry.rectifiedDirty = true;
}

/**
 * Release every per-image source entry: revoke owned blob URLs, free cached Mats, and reset the
 * per-image array back to empty. Safe to call when no images are loaded.
 *
 * @param {import("./dom-state.js").state} state
 * @returns {void}
 */
export function releaseAllSourceImages(state) {
  const images = state.source.images;
  if (Array.isArray(images)) {
    for (const entry of images) {
      if (!entry) continue;
      if (entry.ownedObjectUrl) {
        try {
          URL.revokeObjectURL(entry.ownedObjectUrl);
        } catch {
          /* already revoked */
        }
        entry.ownedObjectUrl = "";
      }
      releaseEntryRectifiedCache(entry);
      entry.image = null;
      entry.canvas = null;
    }
  }
  state.source.images = [];
  state.source.activeImageIndex = 0;
}
