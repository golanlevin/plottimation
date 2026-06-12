/**
 * Per-frame image strip UI (Phase 7).
 *
 * The strip is only meaningful in the per-frame alignment pipeline, where each uploaded image is one
 * animation frame. It renders one thumbnail per `state.source.images[i]` and lets the user:
 *   - switch the active image (click) — UI navigation only, no reprocessing;
 *   - reorder frames (HTML5 drag-and-drop within the strip) — reprocesses (frame order changed);
 *   - delete a frame (× on hover) — releases that entry's blob URL / canvas / cached Mat and
 *     reprocesses with N-1 frames;
 *   - add more frames (the trailing `+` tile) — reuses the Phase 4 decode path and reprocesses.
 *
 * This module deliberately holds all strip rendering + event handling so app.js / ui-controls.js stay
 * lean. It is wired in from ui-controls.js with the small set of callbacks it needs (active-image
 * select, reprocess trigger, add-images load path) plus the shared `dom` / `state` handles.
 */
import { t } from "./i18n.js";
import {
  getActiveSourceImage,
  releaseEntryRectifiedCache,
} from "./source-images.js";

/** @type {StripDeps | null} Bound dependencies, set once by attachPerFrameStrip. */
let deps = null;

/** Signature of the last render so re-renders only rebuild when images[]/activeIndex changed. */
let lastRenderSignature = "";

/** Index of the thumbnail currently being dragged (reorder), or -1 when not dragging. */
let dragSourceIndex = -1;

/**
 * @typedef {Object} StripDeps
 * @property {import("./dom-state.js").dom} dom
 * @property {import("./dom-state.js").state} state
 * @property {(index:number) => void} setActiveImage Switch the active image (no reprocess).
 * @property {() => void} reprocess Trigger a debounced reprocess (reorder/delete).
 * @property {(files: File[]) => Promise<void>} addImageFiles Decode + append images, then reprocess.
 * @property {() => boolean} isPerFrameModeActive Whether the per-frame pipeline is currently active.
 * @property {() => void} clearPreviews Blank all downstream previews (used for the empty state when the
 *   last image is deleted, since `reprocess` no-ops with no source image).
 */

/**
 * Wire the per-frame strip's add-images file input and remember the shared dependencies.
 *
 * Safe to call once during app startup. The strip itself is rendered lazily via `renderPerFrameStrip`.
 *
 * @param {StripDeps} boundDeps
 * @returns {void}
 */
export function attachPerFrameStrip(boundDeps) {
  deps = boundDeps;
  const { dom } = deps;
  const addInput = dom.perFrameStripFileInput;
  if (addInput) {
    addInput.addEventListener("change", () => {
      const files = Array.from(addInput.files || []).filter(Boolean);
      // Reset the input so picking the same file again still fires `change`.
      addInput.value = "";
      if (files.length === 0) return;
      void deps.addImageFiles(files);
    });
  }
}

/**
 * Build a cheap signature describing the current strip contents so we only rebuild on real changes.
 *
 * @returns {string}
 */
function computeSignature() {
  const { state } = deps;
  const images = Array.isArray(state.source.images) ? state.source.images : [];
  const parts = images.map((entry) => (entry && entry.canvas ? "1" : "0"));
  return `${state.source.activeImageIndex}|${images.length}|${parts.join(",")}`;
}

/**
 * Re-render the strip if the per-frame mode visibility or the images[]/activeIndex changed.
 *
 * Hidden (and emptied) in markers / markerless modes so legacy flows never see strip markup.
 * Idempotent: a no-op when neither the visibility nor the signature changed since the last render.
 *
 * @returns {void}
 */
export function renderPerFrameStrip() {
  if (!deps) return;
  const { dom, state, isPerFrameModeActive } = deps;
  const panel = dom.perFrameStripPanel;
  const container = dom.perFrameStrip;
  if (!panel || !container) return;

  const active = isPerFrameModeActive();
  if (!active) {
    // Leave no strip markup behind in legacy modes.
    if (!panel.hidden || container.childElementCount > 0) {
      panel.hidden = true;
      container.replaceChildren();
      lastRenderSignature = "";
    }
    return;
  }
  panel.hidden = false;

  const signature = computeSignature();
  if (signature === lastRenderSignature && container.childElementCount > 0) {
    // Nothing visible changed (count + per-entry presence + activeIndex all match); avoid thrashing
    // the DOM. Reorder/delete reset `lastRenderSignature` to "" first to force a rebuild, since a
    // reorder can leave the signature unchanged while the visible order differs.
    return;
  }
  lastRenderSignature = signature;

  const images = Array.isArray(state.source.images) ? state.source.images : [];
  const activeIndex = state.source.activeImageIndex;
  const fragment = document.createDocumentFragment();

  images.forEach((entry, index) => {
    fragment.appendChild(buildThumbnail(entry, index, index === activeIndex));
  });
  fragment.appendChild(buildAddTile());
  container.replaceChildren(fragment);

  // Frame-count readout (singular / plural).
  const count = images.length;
  if (dom.perFrameStripCount) {
    dom.perFrameStripCount.textContent =
      count === 1 ? t("photo.strip.frameCountOne") : t("photo.strip.frameCount", { count });
  }
}

/**
 * Build one thumbnail tile for a source entry.
 *
 * @param {import("./source-images.js").SourceImageEntry} entry
 * @param {number} index
 * @param {boolean} isActive
 * @returns {HTMLElement}
 */
function buildThumbnail(entry, index, isActive) {
  const tile = document.createElement("div");
  tile.className = "per-frame-thumb";
  tile.setAttribute("role", "listitem");
  tile.dataset.index = String(index);
  tile.draggable = true;
  if (isActive) tile.classList.add("is-active");
  tile.setAttribute("aria-label", t("photo.strip.selectLabel", { index: index + 1 }));

  const img = document.createElement("img");
  // Prefer a drag/display URL; fall back to drawing from the entry's canvas via a data URL is avoided
  // for cost — the dragUrl (blob/demo) is always present for loaded entries.
  if (entry && entry.dragUrl) {
    img.src = entry.dragUrl;
  } else if (entry && entry.canvas) {
    try {
      img.src = entry.canvas.toDataURL("image/jpeg", 0.5);
    } catch {
      /* tainted/empty canvas — leave src empty */
    }
  }
  img.alt = "";
  tile.appendChild(img);

  const number = document.createElement("span");
  number.className = "per-frame-thumb-number";
  number.textContent = String(index + 1);
  tile.appendChild(number);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "per-frame-thumb-delete";
  del.textContent = "×"; // ×
  del.setAttribute("aria-label", t("photo.strip.deleteLabel", { index: index + 1 }));
  del.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteImageAt(index);
  });
  tile.appendChild(del);

  tile.addEventListener("click", () => {
    selectImageAt(index);
  });

  attachReorderHandlers(tile, index);
  return tile;
}

/**
 * Build the trailing `+` tile that adds more images.
 *
 * @returns {HTMLElement}
 */
function buildAddTile() {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "per-frame-thumb-add";
  tile.textContent = "+";
  tile.setAttribute("aria-label", t("photo.strip.addLabel"));
  tile.addEventListener("click", () => {
    deps.dom.perFrameStripFileInput?.click();
  });
  // Allow dropping additional images directly onto the add tile.
  tile.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types?.includes("Files")) {
      event.preventDefault();
      tile.classList.add("is-drag-over");
    }
  });
  tile.addEventListener("dragleave", () => {
    tile.classList.remove("is-drag-over");
  });
  tile.addEventListener("drop", (event) => {
    tile.classList.remove("is-drag-over");
    const files = Array.from(event.dataTransfer?.files || []).filter((file) =>
      String(file.type || "").startsWith("image/"),
    );
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void deps.addImageFiles(files);
  });
  return tile;
}

/**
 * Wire HTML5 drag-and-drop reorder handlers on a thumbnail tile. Scoped to the strip: we only react
 * to drags whose source index we recorded on `dragstart`.
 *
 * @param {HTMLElement} tile
 * @param {number} index
 * @returns {void}
 */
function attachReorderHandlers(tile, index) {
  tile.addEventListener("dragstart", (event) => {
    dragSourceIndex = index;
    tile.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      // Some browsers require data to be set for the drag to begin.
      try {
        event.dataTransfer.setData("text/plain", String(index));
      } catch {
        /* ignore */
      }
    }
  });
  tile.addEventListener("dragend", () => {
    dragSourceIndex = -1;
    tile.classList.remove("is-dragging");
  });
  tile.addEventListener("dragover", (event) => {
    // Only handle in-strip thumbnail reorders (a recorded source index). File drags fall through to
    // the add tile / drop zone.
    if (dragSourceIndex < 0) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    tile.classList.add("is-drag-over");
  });
  tile.addEventListener("dragleave", () => {
    tile.classList.remove("is-drag-over");
  });
  tile.addEventListener("drop", (event) => {
    tile.classList.remove("is-drag-over");
    if (dragSourceIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const from = dragSourceIndex;
    dragSourceIndex = -1;
    reorderImages(from, index);
  });
}

/**
 * Select the active image at `index` (UI navigation; no reprocess).
 *
 * @param {number} index
 * @returns {void}
 */
function selectImageAt(index) {
  deps.setActiveImage(index);
  renderPerFrameStrip();
}

/**
 * Move the entry at `from` to occupy position `to`, keeping the same logical entry active, and
 * reprocess because frame order changed.
 *
 * @param {number} from
 * @param {number} to
 * @returns {void}
 */
function reorderImages(from, to) {
  const { state } = deps;
  const images = state.source.images;
  if (!Array.isArray(images)) return;
  if (from === to || from < 0 || to < 0 || from >= images.length || to >= images.length) return;

  // Track which entry is currently active so the same logical image stays selected after reorder.
  const activeEntry = getActiveSourceImage(state);
  const [moved] = images.splice(from, 1);
  images.splice(to, 0, moved);

  // Re-derive the active index from the moved entry's new position.
  const newActiveIndex = activeEntry ? images.indexOf(activeEntry) : 0;
  // Repoint legacy projections at the (unchanged logical) active entry without redundant work.
  deps.setActiveImage(newActiveIndex >= 0 ? newActiveIndex : 0);

  // Force a rebuild even though signature length is unchanged (order changed but counts did not).
  lastRenderSignature = "";
  renderPerFrameStrip();
  deps.reprocess();
}

/**
 * Delete the entry at `index`: release its blob URL + canvas + cached rectified Mat, adjust the
 * active index, and reprocess with N-1 frames. Deleting the last image returns to an empty state.
 *
 * @param {number} index
 * @returns {void}
 */
function deleteImageAt(index) {
  const { state } = deps;
  const images = state.source.images;
  if (!Array.isArray(images) || index < 0 || index >= images.length) return;

  const [removed] = images.splice(index, 1);
  releaseEntry(removed);

  if (images.length === 0) {
    // Empty state: clear the active index and the legacy projections so the app reads "no image".
    state.source.activeImageIndex = 0;
    state.source.image = null;
    lastRenderSignature = "";
    renderPerFrameStrip();
    // `reprocess` (scheduleProcess) no-ops with no source image, which would leave the prior
    // rectified sheet / animation on screen. Blank the downstream previews instead so the empty
    // state is visually consistent.
    deps.clearPreviews();
    return;
  }

  // Keep the active selection sensible: clamp to the new range, biasing toward the prior neighbor.
  let nextActive = state.source.activeImageIndex;
  if (index < nextActive) nextActive -= 1;
  if (nextActive >= images.length) nextActive = images.length - 1;
  if (nextActive < 0) nextActive = 0;
  deps.setActiveImage(nextActive);

  lastRenderSignature = "";
  renderPerFrameStrip();
  deps.reprocess();
}

/**
 * Release every owned resource of a removed entry: its blob URL, cached rectified Mat, and canvas.
 *
 * @param {import("./source-images.js").SourceImageEntry | null | undefined} entry
 * @returns {void}
 */
function releaseEntry(entry) {
  if (!entry) return;
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
