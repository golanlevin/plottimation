/**
 * Image-load controller helpers.
 *
 * This module handles busy-state spinners, object-URL ownership, file-type discrimination,
 * and the staged process of loading a new source image into the app.
 */
import { t } from "./i18n.js";
import { createSourceImageEntry, releaseAllSourceImages } from "./source-images.js";
/**
 * Toggle the small busy spinners used during image loading and processing.
 *
 * @param {import("./dom-state.js").dom} dom
 * @param {import("./dom-state.js").state} state
 * @param {boolean} busy
 * @returns {void}
 */
export function setBusyState(dom, state, busy) {
  state.runtime.busy = !!busy;
  document.body.classList.toggle("busy-loading", !!busy);
  dom.statusBusy.hidden = !busy;
  dom.rawBusy.hidden = !busy;
  if (dom.previewBusy) {
    dom.previewBusy.hidden = !(
      busy ||
      document.body.classList.contains("geometry-processing") ||
      document.body.classList.contains("stabilization-processing") ||
      !!state.processing?.stabilizationMeasurementActive
    );
  }
}

/**
 * Yield long enough for the browser to paint any newly drawn preview canvases.
 *
 * @returns {Promise<void>}
 */
export async function waitForNextPaint() {
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Decode an image URL into a fully-loaded `HTMLImageElement`.
 *
 * Used by the multi-file (per-frame) load path to decode each additional uploaded image into its
 * own entry. Rejects if the image fails to decode so the caller can skip just that file.
 *
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
export function decodeImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image"));
    image.src = src;
  });
}

/**
 * Release any blob URLs the app currently owns for raw-photo drag/download behavior, including the
 * per-image source entries, so nothing leaks across image reloads.
 *
 * @param {import("./dom-state.js").state} state
 * @returns {void}
 */
export function releaseOwnedSourceUrl(state) {
  // Revoke per-image blob URLs and free cached Mats; clears state.source.images back to empty.
  releaseAllSourceImages(state);
  if (!state.source.ownedObjectUrl) return;
  URL.revokeObjectURL(state.source.ownedObjectUrl);
  state.source.ownedObjectUrl = "";
}

/**
 * Reattach buffered per-image overrides (from a per-frame settings restore) to the loaded images.
 *
 * `applyLoadedSettingsText` parses a per-frame `_settings.txt`'s indexed page-corner / post-rotation
 * keys into `state.source.pendingPerImageOverrides` (shape documented in `js/dom-state.js`). Because a
 * saved project cannot embed image data, those overrides wait here until the user re-uploads the same
 * N images in the same order; this applies each override to `state.source.images[i]` by upload order
 * (index 0 → first uploaded image) and clears the buffer so a later re-load never reapplies stale data.
 *
 * @param {import("./dom-state.js").state} state
 * @returns {boolean} `true` when a per-frame restore buffer was present and consumed.
 */
export function applyPendingPerImageOverrides(state) {
  const pending = state.source.pendingPerImageOverrides;
  if (!pending || !Array.isArray(pending.overrides)) return false;
  const images = state.source.images || [];
  for (let index = 0; index < images.length; index += 1) {
    const override = pending.overrides[index];
    if (!override) continue;
    const entry = images[index];
    if (!entry) continue;
    entry.manualPageContour =
      Array.isArray(override.manualPageContour) && override.manualPageContour.length === 4
        ? override.manualPageContour.map((point) => ({ x: point.x, y: point.y }))
        : null;
    entry.postRotationDeg = Number.isFinite(override.postRotationDeg) ? override.postRotationDeg : 0;
  }
  // Consume the buffer so a subsequent image load does not reapply these (now-stale) overrides.
  state.source.pendingPerImageOverrides = null;
  return true;
}

/**
 * Test whether a dropped/selected file should be treated as an image source.
 *
 * @param {File | null | undefined} file
 * @returns {boolean}
 */
function isImageFile(file) {
  if (!file) return false;
  if (String(file.type || "").startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i.test(file.name || "");
}

/**
 * Test whether a dropped/selected file is a companion settings manifest.
 *
 * @param {File | null | undefined} file
 * @returns {boolean}
 */
function isSettingsFile(file) {
  if (!file) return false;
  return /_settings\.txt$/i.test(file.name || "");
}

/**
 * Convert an image filename like `mySrcImage.jpg` into `mySrcImage_settings.txt`.
 *
 * @param {string} filename
 * @returns {string}
 */
function getExpectedSettingsFilename(filename) {
  return (filename || "").replace(/\.[^.]+$/, "") + "_settings.txt";
}

/**
 * Load an image selected by the user from a File object.
 *
 * @param {File} file
 * @param {FileList | File[] | null} [files=null]
 * @param {{
 *   state: import("./dom-state.js").state,
 *   loadImageSource: (src:string, filename?:string, mimeType?:string, settingsFile?:File | null, additionalImageFiles?:File[]) => Promise<void>,
 *   applySettingsFile: (file: File) => Promise<void>
 * }} deps
 * @returns {Promise<void>}
 */
export async function handleFile(file, files = null, { state, loadImageSource, applySettingsFile }) {
  const allFiles = [...(files || [file])].filter(Boolean);
  // A drag payload may contain one image, several images (one per animation frame), and/or a
  // sibling settings file. Prefer images when present; otherwise treat a lone settings file as an
  // override request.
  const imageFiles = allFiles.filter(isImageFile);
  const primaryImageFile = imageFiles[0] || (isImageFile(file) ? file : null);
  if (primaryImageFile) {
    releaseOwnedSourceUrl(state);
    const url = URL.createObjectURL(primaryImageFile);
    // A sibling settings file is matched against the first image's name and applied once.
    const settingsFilename = getExpectedSettingsFilename(primaryImageFile.name || "");
    const siblingSettingsFile = allFiles.find((candidate) => candidate && isSettingsFile(candidate) && candidate.name === settingsFilename) || null;
    // Any images beyond the first become additional per-frame entries; the loader switches into
    // per-frame mode when more than one image is present so none are silently dropped.
    const additionalImageFiles = imageFiles.length > 0 ? imageFiles.slice(1) : [];
    await loadImageSource(url, primaryImageFile.name || "", primaryImageFile.type || "image/jpeg", siblingSettingsFile, additionalImageFiles);
    return;
  }

  const settingsFile = allFiles.find(isSettingsFile) || (isSettingsFile(file) ? file : null);
  if (settingsFile) {
    await applySettingsFile(settingsFile);
  }
}

/**
 * Load an image from a URL, reset dependent state, and kick off processing.
 *
 * @param {{
 *   src: string,
 *   filename?: string,
 *   mimeType?: string,
 *   settingsFile?: File | null,
 *   additionalImageFiles?: File[],
 *   additionalImageSources?: { src: string, filename?: string, mimeType?: string }[],
 *   companionSettingsText?: string | null,
 *   dom: import("./dom-state.js").dom,
 *   state: import("./dom-state.js").state,
 *   setStatus: (text:string) => void,
 *   setActiveViewerTab?: (view:string) => void,
 *   collapseAllPanels: () => void,
 *   resetNonLayoutControls: () => void,
 *   revokeGifUrl: () => void,
 *   clearAllPreviews: () => void,
 *   renderRawPreview: () => void,
 *   setGeometryProcessingCursor?: (active: boolean) => void,
 *   syncRawPhotoHeadingLink?: () => void,
 *   syncRawPhotoCreditDisplay?: () => void,
 *   syncPaperPresetUi?: () => void,
 *   loadCompanionSettingsText: (src:string, filename:string, settingsFile?:File | null) => Promise<string>,
 *   applyLoadedSettingsText: (settingsText:string) => void,
 *   invalidateAppearanceCache: () => void,
 *   processCurrentImage: () => Promise<void>,
 *   drawImageToCanvas: (image: HTMLImageElement, canvas: HTMLCanvasElement) => void,
 *   refreshActiveImage?: (index:number) => void,
 * }} deps
 * @returns {Promise<void>}
 */
export async function loadImageSource({
  src,
  filename = "",
  mimeType = "image/jpeg",
  settingsFile = null,
  additionalImageFiles = [],
  additionalImageSources = [],
  companionSettingsText = null,
  dom,
  state,
  setStatus,
  setActiveViewerTab,
  collapseAllPanels,
  resetNonLayoutControls,
  revokeGifUrl,
  clearAllPreviews,
  renderRawPreview,
  setGeometryProcessingCursor,
  syncRawPhotoHeadingLink,
  syncRawPhotoCreditDisplay,
  syncPaperPresetUi,
  loadCompanionSettingsText,
  applyLoadedSettingsText,
  invalidateAppearanceCache,
  processCurrentImage,
  drawImageToCanvas,
  refreshActiveImage,
}) {
  releaseOwnedSourceUrl(state);
  if (src.startsWith("blob:")) {
    state.source.ownedObjectUrl = src;
  }
  setBusyState(dom, state, true);
  setGeometryProcessingCursor?.(true);
  setStatus(t("status.loadingImage"));
  // On mobile, a new image load should bring the user back to the Page tab before the
  // previews are cleared and redrawn.
  if (state.runtime.mobileSingleViewerMode) {
    setActiveViewerTab?.("raw");
  }
  collapseAllPanels();
  resetNonLayoutControls();
  revokeGifUrl();
  // Clear the old filename before syncing the Page Corners header, otherwise the filename fallback
  // can briefly show the previous image's name while the next image/demo is still loading.
  state.source.filename = "";
  state.source.dragUrl = "";
  state.source.mimeType = "";
  state.source.sourceCredit = "";
  state.source.settingsLoaded = false;
  dom.rawPhotoHeadingText?.removeAttribute("href");
  syncRawPhotoHeadingLink?.();
  syncRawPhotoCreditDisplay?.();
  clearAllPreviews();
  // The UI resets to defaults first, then an optional sibling settings file is layered on top.
  const settingsText =
    companionSettingsText != null
      ? companionSettingsText
      : await loadCompanionSettingsText(src, filename, settingsFile);

  const image = new Image();
  image.onload = async () => {
    try {
      document.body.classList.add("has-loaded-image");
      state.source.image = image;
      state.source.filename = filename || "";
      state.source.sourceCredit = state.source.sourceCredit || "";
      state.source.mimeType = mimeType || "image/jpeg";
      state.source.dragUrl = src;
      syncRawPhotoHeadingLink?.();
      syncRawPhotoCreditDisplay?.();
      state.source.rawPageContour = null;
      // Each per-frame entry owns a distinct source-resolution canvas so runPerFramePipeline can
      // rectify a different image per cell. The legacy state.source.canvas / image fields project the
      // active (index 0) entry, keeping single-image markers/markerless callers working unchanged.
      const activeCanvas = document.createElement("canvas");
      drawImageToCanvas(image, activeCanvas);
      state.source.canvas = activeCanvas;
      const sourceEntry = createSourceImageEntry({
        image,
        filename: state.source.filename,
        mimeType: state.source.mimeType,
        ownedObjectUrl: state.source.ownedObjectUrl,
        dragUrl: state.source.dragUrl,
        canvas: activeCanvas,
      });
      const entries = [sourceEntry];
      // Decode any additional uploaded images into their own entries (multi-file / per-frame upload).
      // Each extra image owns its own blob URL and canvas; a failed decode is skipped rather than
      // aborting the whole load.
      for (const extraFile of additionalImageFiles) {
        if (!extraFile) continue;
        const extraUrl = URL.createObjectURL(extraFile);
        let extraImage;
        try {
          extraImage = await decodeImageElement(extraUrl);
        } catch {
          try {
            URL.revokeObjectURL(extraUrl);
          } catch {
            /* already revoked */
          }
          continue;
        }
        const extraCanvas = document.createElement("canvas");
        drawImageToCanvas(extraImage, extraCanvas);
        entries.push(
          createSourceImageEntry({
            image: extraImage,
            filename: extraFile.name || "",
            mimeType: extraFile.type || "image/jpeg",
            ownedObjectUrl: extraUrl,
            dragUrl: extraUrl,
            canvas: extraCanvas,
          }),
        );
      }
      // URL-based extras (bundled per-frame demos) decode directly without creating blob URLs.
      for (const extraSource of additionalImageSources) {
        if (!extraSource?.src) continue;
        let extraImage;
        try {
          extraImage = await decodeImageElement(extraSource.src);
        } catch {
          continue;
        }
        const extraCanvas = document.createElement("canvas");
        drawImageToCanvas(extraImage, extraCanvas);
        entries.push(
          createSourceImageEntry({
            image: extraImage,
            filename: extraSource.filename || "",
            mimeType: extraSource.mimeType || "image/jpeg",
            ownedObjectUrl: "",
            dragUrl: extraSource.src,
            canvas: extraCanvas,
          }),
        );
      }
      state.source.images = entries;
      state.source.activeImageIndex = 0;
      // Multiple uploaded images mean the user wants the per-frame pipeline (image count = frame
      // count), so force it on and never silently drop the extras. The real radio arrives in Phase 6;
      // until then state.runtime.forcePerFrameMode drives readConfig. Ticking the radio when present
      // keeps this forward-compatible.
      if (entries.length > 1) {
        state.runtime.forcePerFrameMode = true;
        if (dom.alignmentPipelinePerFrame) {
          dom.alignmentPipelinePerFrame.checked = true;
        }
      }
      syncPaperPresetUi?.();
      renderRawPreview();
      const hasSettingsText = !!settingsText.trim();
      const loadedWhat = hasSettingsText ? t("status.loadedImageAndSettings") : t("status.loadedImage");
      state.preview.rectifiedViewMode = hasSettingsText ? "post" : "pre";
      if (hasSettingsText) {
        // Apply the saved settings before CV runs so detection/extraction starts from the restored state.
        applyLoadedSettingsText(settingsText);
        state.source.settingsLoaded = true;
      }
      // Keep the active entry's page-corner override in sync with the legacy field after any
      // settings load. Per-image override routing (the per-frame buffer below) takes precedence; this
      // just mirrors the single-image/legacy case.
      sourceEntry.manualPageContour = state.source.manualPageContour ?? null;
      // Per-frame settings restore: a saved project cannot embed image data, so the user re-uploads the
      // same N images in the same order. applyLoadedSettingsText parsed the indexed per-image overrides
      // into state.source.pendingPerImageOverrides; reattach each one to its image by upload order, then
      // consume the buffer so a later re-load does not reapply stale overrides. Only when overrides were
      // actually restored do we refresh the active entry's legacy field + Post-Rotation slider + Page
      // Corners overlay + strip via setActiveImage, so single-image markers/markerless loads are
      // untouched.
      if (applyPendingPerImageOverrides(state)) {
        refreshActiveImage?.(state.source.activeImageIndex);
      }
      invalidateAppearanceCache();
      setStatus(`${loadedWhat}\n${t("status.analyzingPage")}`);
      await waitForNextPaint();
      await processCurrentImage();
    } finally {
      if (!state.processing.active && !state.processing.pending) {
        setBusyState(dom, state, false);
        setGeometryProcessingCursor?.(false);
      }
    }
  };
  image.onerror = () => {
    setBusyState(dom, state, false);
    setGeometryProcessingCursor?.(false);
    state.source.dragUrl = "";
    state.source.mimeType = "";
    state.source.filename = "";
    state.source.sourceCredit = "";
    state.source.settingsLoaded = false;
    syncRawPhotoHeadingLink?.();
    syncRawPhotoCreditDisplay?.();
    releaseOwnedSourceUrl(state);
    setStatus(t("status.failedToLoadImage"));
  };
  image.src = src;
}
