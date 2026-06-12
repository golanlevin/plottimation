/**
 * Main application orchestrator.
 *
 * This module ties together UI state, preview rendering, the OpenCV pipeline, settings I/O,
 * export flows, and cache invalidation. Most other modules are narrower helpers that are called
 * from here.
 */
import { PAPER_PRESETS, dom, state } from "./dom-state.js";
import { SETTINGS_DEFAULTS, applyAppearanceDefaults, applyCropGeometryDefaults, applyNonLayoutDefaults } from "./settings-defaults.js";
import {
  loadCompanionSettingsText as loadCompanionSettingsTextViaIo,
  applyLoadedSettingsText as applyLoadedSettingsTextViaIo,
  makeSettingsFilename as makeSettingsFilenameViaIo,
  buildSettingsTsv as buildSettingsTsvViaIo,
} from "./settings-io.js";
import { renderCrossRoiGrid as renderCrossRoiGridViaEditor } from "./marker-editor.js";
import { applyVisualAdjustments, hasAppearanceAdjustments } from "./appearance.js";
import { drawImageToCanvas, renderCanvasFit, resizeCanvasToBox } from "./canvas-view.js";
import {
  updateExportButtonLabel as updateExportButtonLabelViaController,
  revokeGifUrl as revokeGifUrlViaController,
  sanitizeFilenameBase,
  detectMp4ExportSupport,
  exportGif as exportGifViaController,
  exportMp4 as exportMp4ViaController,
  exportZip as exportZipViaController,
  saveSettingsFile as saveSettingsFileViaController,
} from "./export-controller.js";
import {
  updateRectifiedSheetHeading as syncRectifiedSheetHeading,
  updatePageGridDetectionHeading as syncPageGridDetectionHeading,
  setStatus as syncStatusText,
} from "./status-controller.js";
import {
  setBusyState as syncBusyState,
  releaseOwnedSourceUrl as releaseSourceUrl,
  handleFile as loadFileSource,
  loadImageSource as loadImageSourceViaController,
  decodeImageElement,
  applyPendingPerImageOverrides,
} from "./load-controller.js";
import {
  releaseRectifiedDragUrl as releaseRectifiedDragAsset,
  primeRectifiedDragAsset as buildRectifiedDragAsset,
  makeCanvasDraggable as attachCanvasDragAsset,
  makeGifImageDraggable as attachGifImageDragAsset,
  makeLivePreviewDragCue as attachLivePreviewDragCue,
  makeRectifiedFilename,
} from "./drag-assets.js";
import {
  attachUi as wireUiControls,
  initializeTooltips as registerTooltips,
  setTooltipsEnabled as applyTooltipState,
} from "./ui-controls.js";
import {
  updateAnimationPreviewHeading as syncAnimationPreviewHeading,
  updatePreviewPlayPauseButton as syncPreviewPlayPauseButton,
  getOrderedFrameCount as getPreviewOrderedFrameCount,
  getOrderedFrameIndex as getPreviewOrderedFrameIndex,
  startGifPreviewLoop as startPreviewLoop,
  drawCurrentGifPreview as drawPreviewFrame,
  rerenderPreviews as rerenderPreviewSurfaces,
} from "./preview-controller.js";
import {
  runPipeline,
  previewPageBoundary,
  estimateCrossRoiSidePx,
  estimateMarkerlessCornerTileSidePx,
  capMarkerlessCornerTileSidePx,
  buildCrossConvolutionCanvas,
  getCvInterpolationFlag,
  extractSingleFrameToCanvas,
} from "./pipeline.js";
import { applyTranslations, getTooltipText, t } from "./i18n.js";
import {
  setActiveSourceImage,
  setActiveManualPageContour,
  setActivePostRotationDeg,
  createSourceImageEntry,
  releaseEntryRectifiedCache,
} from "./source-images.js";
import { renderPerFrameStrip } from "./per-frame-strip.js";
// Final output-size scaling can be done either with browser canvas drawImage() or with OpenCV.
// Keep both code paths available for comparison while evaluating tiny-output quality.
const bUseOpenCvOutputScaling = true;
const MOBILE_VIEWER_BREAKPOINT_PX = 960;
const LIVE_THRESHOLD_PREVIEW_MAX_LONG_EDGE_PX = 512;
const RECTIFIED_FULL_RES_EAGER_LONG_EDGE_PX = 3000;
const PAGE_CORNER_HIT_RADIUS_CSS_PX = 14;
const PAGE_CORNER_MAGNIFIER_SIZE_SCALE = 1.4;
const PAGE_CORNER_MAGNIFIER_SCALE = 4;
const DEFAULT_PAGE_CORNER_INSET_DIAGONAL_FRACTION = 0.1;
const FRAME_MATCH_WEIGHT_CACHE = new Map();
const STABILIZATION_MEASUREMENT_CHUNK_SIZE = 4;

const TOOLTIP_TEXT = getTooltipText();

init();

/**
 * Set the Export GIF button label, optionally with an in-progress percentage suffix.
 *
 * @param {number | null} [progressPercent=null]
 * @returns {void}
 */
function updateExportButtonLabel(progressPercent = null) {
  updateExportButtonLabelViaController(dom, progressPercent);
}

/**
 * Read the shared 1..100 encoding-quality slider.
 *
 * @returns {number}
 */
function getEncodingQualityValue() {
  const parsed = Number(dom.gifQuality.value);
  return Math.max(1, Math.min(100, Number.isFinite(parsed) ? parsed : SETTINGS_DEFAULTS.gifExport.quality));
}

/**
 * Map the shared 1..100 quality slider onto gif.js's inverse 20..1 quality scale.
 *
 * @param {number} encodingQuality
 * @returns {number}
 */
function mapEncodingQualityToGifEncoderQuality(encodingQuality) {
  const clamped = Math.max(1, Math.min(100, encodingQuality));
  const normalized = (clamped - 1) / 99;
  return Math.max(1, Math.min(20, Math.round(20 - (normalized * 19))));
}

/**
 * Build the stable string key used for marker override storage.
 *
 * @param {number} col
 * @param {number} row
 * @returns {string}
 */
function getMarkerKey(col, row) {
  return `${col},${row}`;
}

/**
 * Populate the Load Demo pulldown from a small manifest in `demo/index.json`.
 *
 * Browsers do not reliably expose directory listings to client-side code, so this manifest keeps
 * demo filenames out of the app logic while still allowing the UI to reflect the current demo set.
 *
 * @returns {Promise<void>}
 */
async function populateDemoSelect() {
  const select = dom.loadDemoSelect;
  if (!select) return;
  try {
    const response = await fetch("demo/index.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifestText = await response.text();
    const filenames = parseDemoManifest(manifestText);
    for (const filename of filenames) {
      if (typeof filename !== "string") continue;
      const option = document.createElement("option");
      option.value = filename;
      option.textContent = filename;
      select.appendChild(option);
    }
    select.disabled = filenames.length === 0;
    maybeLoadStartupDemoFromUrl(filenames);
  } catch (error) {
    console.warn("Could not populate demo list.", error);
    select.disabled = true;
  }
}

/**
 * Parse the demo manifest text into an array of filenames.
 *
 * This accepts strict JSON, JSON with trailing commas, or a simple newline list.
 *
 * @param {string} manifestText
 * @returns {string[]}
 */
function parseDemoManifest(manifestText) {
  const trimmed = String(manifestText || "").trim();
  if (!trimmed) return [];
  try {
    // Accept slightly sloppy JSON manifests too, since these files are hand-edited and small.
    const parsed = JSON.parse(trimmed.replace(/,\s*([\]}])/g, "$1"));
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === "string");
    }
  } catch {
    // Fall through to the simple line-based parser below.
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^["']|["'],?$/g, "").replace(/,$/, ""))
    .filter(Boolean);
}

/**
 * Auto-load one bundled demo when the page URL includes `?demo=...`.
 *
 * The requested filename must exist in the demo manifest; otherwise this is ignored. This keeps
 * direct shared links on the supported bundled-demo path instead of probing arbitrary files.
 *
 * Example:
 * - `index.html?demo=9_riso_kellianderson.jpg`
 *
 * @param {string[]} manifestFilenames
 * @returns {void}
 */
function maybeLoadStartupDemoFromUrl(manifestFilenames) {
  const params = new URLSearchParams(globalThis.location?.search || "");
  const requestedDemo = String(params.get("demo") || "").trim();
  if (!requestedDemo) return;
  if (!manifestFilenames.includes(requestedDemo)) {
    console.warn(`Ignoring unknown demo request: ${requestedDemo}`);
    return;
  }
  if (dom.loadDemoSelect) {
    dom.loadDemoSelect.value = requestedDemo;
  }
  void loadSelectedDemo(requestedDemo);
}

/**
 * Guess an image MIME type from a filename extension.
 *
 * @param {string} filename
 * @returns {string}
 */
function guessImageMimeType(filename) {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * Load one bundled demo entry from `demo/index.json`.
 *
 * Single-image demos load `demo/<filename>` with a sibling settings file. Folder demos (for example
 * `11_per_frame`) load every image listed in `demo/<id>/manifest.json` together with that folder's
 * settings file.
 *
 * @param {string} demoId
 * @returns {Promise<void>}
 */
async function loadSelectedDemo(demoId) {
  const folderManifestUrl = `demo/${demoId}/manifest.json`;
  try {
    const response = await fetch(folderManifestUrl, { cache: "no-store" });
    if (response.ok) {
      const manifest = await response.json();
      if (manifest?.type === "per-frame" && Array.isArray(manifest.images) && manifest.images.length > 0) {
        await loadPerFrameFolderDemo(demoId, manifest);
        return;
      }
    }
  } catch {
    // Fall through to the single-image demo path.
  }
  await loadImageSource(`demo/${demoId}`, demoId);
}

/**
 * Load a bundled per-frame demo folder: all manifest images plus the folder settings file.
 *
 * @param {string} demoId
 * @param {{ settings?: string, images: string[] }} manifest
 * @returns {Promise<void>}
 */
async function loadPerFrameFolderDemo(demoId, manifest) {
  const baseUrl = new URL(`demo/${demoId}/`, globalThis.location?.href || window.location.href);
  const settingsName = manifest.settings || `${demoId}_settings.txt`;
  let companionSettingsText = "";
  try {
    const settingsResponse = await fetch(new URL(settingsName, baseUrl).toString(), { cache: "no-store" });
    if (settingsResponse.ok) {
      companionSettingsText = await settingsResponse.text();
    }
  } catch {
    /* settings are optional */
  }
  const imageNames = manifest.images.filter((name) => typeof name === "string" && name.trim());
  const [firstImageName, ...restImageNames] = imageNames;
  if (!firstImageName) return;
  const additionalImageSources = restImageNames.map((name) => ({
    src: new URL(name, baseUrl).toString(),
    filename: name,
    mimeType: guessImageMimeType(name),
  }));
  await loadImageSource(
    new URL(firstImageName, baseUrl).toString(),
    firstImageName,
    guessImageMimeType(firstImageName),
    null,
    [],
    { companionSettingsText, additionalImageSources, demoId },
  );
}

/**
 * Remove the `?demo=` URL parameter once the user starts loading some different image.
 *
 * This keeps shared demo links stable on first open, but prevents the location bar from
 * continuing to advertise the old demo after the user switches to another file or demo.
 *
 * @param {string} nextFilename
 * @param {string} [demoId=""]
 * @returns {void}
 */
function clearDemoQueryIfLoadingDifferentFile(nextFilename, demoId = "") {
  const url = new URL(globalThis.location?.href || "", globalThis.location?.href || window.location.href);
  const currentDemo = String(url.searchParams.get("demo") || "").trim();
  if (!currentDemo) return;
  const nextDemoId = String(demoId || "").trim();
  if (currentDemo === nextDemoId || currentDemo === String(nextFilename || "").trim()) return;
  url.searchParams.delete("demo");
  history.replaceState(null, "", url.toString());
  if (dom.loadDemoSelect) {
    dom.loadDemoSelect.value = "";
  }
}

/**
 * Small local wrapper around the preview module's heading sync.
 *
 * @returns {void}
 */
function updateAnimationPreviewHeading() {
  syncAnimationPreviewHeading(dom, state);
}

/**
 * Small local wrapper around the preview module's play/pause-button sync.
 *
 * @returns {void}
 */
function updatePreviewPlayPauseButton() {
  syncPreviewPlayPauseButton(dom, state);
}

function updateRectifiedSheetHeading() {
  syncRectifiedSheetHeading(dom, state);
  syncRectifiedSheetHeadingLink();
}

/**
 * Keep all page-boundary warning surfaces synchronized.
 *
 * The lightweight threshold preview and the full pipeline both use this helper so the Page Corners
 * warning, Page & Grid Detection warning, and orange Status styling cannot drift apart.
 *
 * @param {boolean} [showWarning=false]
 * @returns {void}
 */
function updatePageGridDetectionHeading(showWarning = false) {
  state.runtime.pageBoundaryWarningVisible = showWarning;
  syncPageGridDetectionHeading(dom, showWarning);
  dom.statusText?.classList.toggle("status-page-boundary-failure", showWarning);
  syncRawPhotoHeadingLink();
}

/**
 * Keep the export buttons synchronized with frame availability and MP4 support.
 *
 * @param {boolean} [forceDisabled=false]
 * @returns {void}
 */
function updateExportControlsAvailability(forceDisabled = false) {
  const hasFrames = state.geometry.frameCount > 0;
  dom.exportButton.disabled = forceDisabled || !hasFrames;
  dom.exportZipButton.disabled = forceDisabled || !hasFrames;
  dom.saveSettingsButton.disabled = forceDisabled || !hasFrames;
  dom.exportMp4Button.disabled = forceDisabled || !hasFrames || !state.runtime.mp4ExportSupported;
}

/**
 * Keep the marker-editing header controls synchronized with current state.
 *
 * Mobile currently treats the marker panel as read-only, so the override controls are hidden
 * there even when alignment data exists.
 *
 * @returns {void}
 */
function syncMarkerEditingUi() {
  const hasAlignmentInfo = !!state.geometry.alignmentInfo;
  const hasEdits = state.geometry.manualMarkerOverrides.size > 0;
  const allowEditing = hasAlignmentInfo && !state.runtime.mobileSingleViewerMode;
  dom.toggleMarkerEditingButton.hidden = state.runtime.mobileSingleViewerMode;
  dom.toggleMarkerEditingButton.disabled = !allowEditing;
  dom.toggleMarkerEditingButton.textContent = state.runtime.markerEditingEnabled
    ? t("alignment.disableOverrides")
    : t("alignment.enableOverrides");
  dom.clearMarkerEditsButton.hidden = state.runtime.mobileSingleViewerMode || !hasEdits;
  dom.clearMarkerEditsButton.disabled = !hasEdits;
  dom.toggleMarkerBlobViewButton.hidden = true;
  dom.toggleMarkerBlobViewButton.disabled = true;
  dom.toggleMarkerBlobViewButton.classList.remove("is-active");
}

/**
 * Keep the Page Corners page-corner override button and cursor state synchronized.
 *
 * @returns {void}
 */
function syncPageCornerEditingUi() {
  const hasImage = !!state.source.image && state.source.canvas.width > 0 && state.source.canvas.height > 0;
  const hasEdits = Array.isArray(state.source.manualPageContour) && state.source.manualPageContour.length === 4;
  if (dom.thresholdOffset) {
    dom.thresholdOffset.disabled = hasEdits;
  }
  if (dom.thresholdOffsetRow) {
    dom.thresholdOffsetRow.classList.toggle("control-disabled", hasEdits);
    dom.thresholdOffsetRow.setAttribute("aria-disabled", String(hasEdits));
    if (hasEdits) {
      dom.thresholdOffsetRow.title = t("tooltip.thresholdOffsetLockedByPageEdits");
    } else if (state.runtime.tooltipsEnabled) {
      dom.thresholdOffsetRow.title = t("tooltip.thresholdOffset");
    } else {
      dom.thresholdOffsetRow.removeAttribute("title");
    }
  }
  if (dom.togglePageCornerEditingButton) {
    dom.togglePageCornerEditingButton.disabled = !hasImage;
    dom.togglePageCornerEditingButton.textContent = state.runtime.pageCornerEditingEnabled
      ? t("alignment.disableOverrides")
      : t("alignment.enableOverrides");
    dom.togglePageCornerEditingButton.classList.remove("is-active");
  }
  if (dom.clearPageCornerEditsButton) {
    dom.clearPageCornerEditsButton.hidden = !hasEdits;
    dom.clearPageCornerEditsButton.disabled = !hasEdits;
  }
  document.body.classList.toggle("raw-page-override-active", state.runtime.pageCornerEditingEnabled && hasImage);
  document.body.classList.toggle("raw-page-corner-dragging", !!state.preview.activePageCornerDrag);
}

/**
 * Nudge the Page Corners Clear Edits button when locked controls are touched.
 *
 * @returns {void}
 */
function triggerPageCornerClearEditsAttention() {
  const button = dom.clearPageCornerEditsButton;
  if (!button || button.hidden || button.disabled) return;
  button.classList.remove("button-ring");
  void button.offsetWidth;
  button.classList.add("button-ring");
  window.clearTimeout(state.preview.pageCornerClearButtonRingTimer || 0);
  state.preview.pageCornerClearButtonRingTimer = window.setTimeout(() => {
    button.classList.remove("button-ring");
  }, 900);
}

/**
 * Keep the temporary markerless phase-debug toggle synchronized with runtime state.
 *
 * @returns {void}
 */
function syncMarkerlessPhaseDebugUi() {
  if (dom.markerlessPhaseDebug) {
    dom.markerlessPhaseDebug.checked = !!state.runtime.markerlessPhaseDebugVisible;
  }
}

/**
 * Arm or clear the one-shot auto-hide timer for a temporary markerless debug view.
 *
 * @param {"markerlessPhaseDebugTimer"|"markerlessWorkingImageTimer"} timerKey
 * @param {(() => void) | null} [onExpire=null]
 * @returns {void}
 */
function resetMarkerlessDebugTimer(timerKey, onExpire = null) {
  const existingTimer = state.runtime[timerKey];
  if (existingTimer) {
    window.clearTimeout(existingTimer);
    state.runtime[timerKey] = 0;
  }
  if (!onExpire) return;
  state.runtime[timerKey] = window.setTimeout(() => {
    state.runtime[timerKey] = 0;
    onExpire();
  }, MARKERLESS_DEBUG_AUTOHIDE_MS);
}

/**
 * Detect whether the viewport should use the mobile single-viewer layout.
 *
 * @returns {boolean}
 */
function isMobileSingleViewerMode() {
  return window.innerWidth <= MOBILE_VIEWER_BREAKPOINT_PX;
}

/**
 * Apply the currently selected mobile control tab to the reparented control groups.
 *
 * @returns {void}
 */
function syncMobileControlTabUi() {
  const mobileMode = state.runtime.mobileSingleViewerMode;
  const activeTab = state.runtime.activeMobileControlTab;
  const tabButtons = [
    dom.mobileControlTabLayout,
    dom.mobileControlTabPageGrid,
    dom.mobileControlTabAlignment,
    dom.mobileControlTabAppearance,
    dom.mobileControlTabCrop,
    dom.mobileControlTabExport,
  ];
  tabButtons.forEach((button) => {
    const isActive = mobileMode && button?.dataset.controlTab === activeTab;
    button?.classList.toggle("is-active", !!isActive);
    button?.setAttribute("aria-selected", String(!!isActive));
  });

  const controlGroups = [
    dom.layoutGroup,
    dom.pageGridDetectionGroup,
    dom.frameAlignmentGroup,
    dom.appearanceGroup,
    dom.cropGeometryGroup,
    dom.exportOptionsGroup,
  ];
  controlGroups.forEach((group) => {
    if (!group) return;
    const isActive = !mobileMode || group.dataset.mobileControl === activeTab;
    if (mobileMode) {
      group.open = isActive;
    }
    group.classList.toggle("mobile-control-active", isActive);
  });
}

/**
 * Switch the active mobile control tab.
 *
 * @param {string} tab
 * @returns {void}
 */
function setActiveMobileControlTab(tab) {
  const validTabs = new Set(["layout", "page-grid", "alignment", "appearance", "crop", "export"]);
  state.runtime.activeMobileControlTab = validTabs.has(tab) ? tab : "layout";
  syncMobileControlTabUi();
}

/**
 * Apply the current responsive viewer mode and active-tab state to the workspace.
 *
 * Desktop keeps all four viewer cards visible. Mobile switches to one visible viewer card at a
 * time, moves the accordion control groups below the viewer, moves Status to the bottom, and
 * forces the marker panel into read-only mode for now.
 *
 * @returns {void}
 */
function syncResponsiveViewerUi() {
  const mobileMode = isMobileSingleViewerMode();
  const previousMode = state.runtime.mobileSingleViewerMode;
  const collapsibleGroups = [
    dom.layoutGroup,
    dom.pageGridDetectionGroup,
    dom.frameAlignmentGroup,
    dom.appearanceGroup,
    dom.cropGeometryGroup,
    dom.exportOptionsGroup,
  ];
  state.runtime.mobileSingleViewerMode = mobileMode;
  document.body.classList.toggle("mobile-layout", mobileMode);
  document.body.classList.toggle("mobile-raw-active", mobileMode && state.runtime.activeViewerTab === "raw");
  document.body.classList.toggle("mobile-preview-active", mobileMode && state.runtime.activeViewerTab === "preview");
  document.body.classList.toggle("mobile-rectified-active", mobileMode && state.runtime.activeViewerTab === "rectified");
  document.body.classList.toggle("mobile-markers-active", mobileMode && state.runtime.activeViewerTab === "markers");
  if (mobileMode) {
    // Reparent the same desktop control groups into the mobile stack instead of maintaining a
    // duplicate mobile-only form. This keeps settings state and reset behavior shared.
    collapsibleGroups.forEach((group) => {
      if (group && dom.mobileControlStack && group.parentElement !== dom.mobileControlStack) {
        if (group.dataset.desktopOpen == null) {
          group.dataset.desktopOpen = group.open ? "true" : "false";
        }
        dom.mobileControlStack.appendChild(group);
      }
    });
    state.preview.showRectifiedDiagnostic = false;
    if (dom.statusGroup && dom.appShell?.lastElementChild !== dom.statusGroup) {
      dom.appShell?.appendChild(dom.statusGroup);
    }
    if (dom.statusGroup) dom.statusGroup.open = true;
  } else {
    // Restore the desktop sidebar ordering when leaving mobile mode.
    if (dom.statusGroup && dom.controlPanel?.lastElementChild !== dom.statusGroup) {
      dom.controlPanel?.appendChild(dom.statusGroup);
    }
    collapsibleGroups.forEach((group) => {
      if (group && dom.controlPanel && group.parentElement !== dom.controlPanel) {
        if (group.dataset.desktopOpen != null) {
          group.open = group.dataset.desktopOpen === "true";
        }
        dom.controlPanel.insertBefore(group, dom.statusGroup);
      }
    });
  }

  const validViews = new Set(["raw", "rectified", "markers", "preview"]);
  if (!validViews.has(state.runtime.activeViewerTab)) {
    state.runtime.activeViewerTab = "raw";
  }

  const tabButtons = [
    dom.viewerTabRaw,
    dom.viewerTabRectified,
    dom.viewerTabMarkers,
    dom.viewerTabPreview,
  ];
  tabButtons.forEach((button) => {
    const isActive = button?.dataset.view === state.runtime.activeViewerTab;
    button?.classList.toggle("is-active", isActive);
    button?.setAttribute("aria-pressed", String(isActive));
  });

  const cards = [
    dom.rawViewerCard,
    dom.rectifiedViewerCard,
    dom.markersViewerCard,
    dom.previewViewerCard,
  ];
  cards.forEach((card) => {
    const isActive = card?.dataset.view === state.runtime.activeViewerTab;
    card?.classList.toggle("viewer-active", !mobileMode || isActive);
  });

  if (mobileMode && state.runtime.markerEditingEnabled) {
    state.runtime.markerEditingEnabled = false;
    renderCrossRoiGrid(state.geometry.alignmentInfo);
  } else if (previousMode !== mobileMode) {
    syncMarkerEditingUi();
  }
  syncMobileControlTabUi();
  syncMobileMarkerGridLayout();
}

/**
 * Keep the mobile Preview card's aspect-ratio hint aligned with the current output dimensions.
 *
 * This lets the mobile preview panel collapse to the same maximized animation shape instead of
 * reserving the full viewer height with extra blank space.
 *
 * @returns {void}
 */
function updateMobilePreviewAspectRatio() {
  const config = readConfig();
  const width = Math.max(1, Math.round(config.exportOptions.outputWidthPx || state.runtime.outputWidthPx || 1));
  const height = Math.max(1, Math.round(config.exportOptions.outputHeightPx || state.runtime.outputHeightPx || 1));
  dom.previewViewerCard?.style.setProperty("--mobile-preview-aspect", `${width} / ${height}`);
}

/**
 * Keep the mobile Rectified Grid card's aspect-ratio hint aligned with the displayed grid.
 *
 * @param {HTMLCanvasElement | null} rectifiedCanvas
 * @returns {void}
 */
function updateMobileRectifiedAspectRatio(rectifiedCanvas) {
  const width = Math.max(1, Math.round(rectifiedCanvas?.width || 1));
  const height = Math.max(1, Math.round(rectifiedCanvas?.height || 1));
  dom.rectifiedViewerCard?.style.setProperty("--mobile-rectified-aspect", `${width} / ${height}`);
}

/**
 * Scale the marker diagnostic grid to fit the mobile viewport width and set the viewport height
 * to the scaled grid height. Desktop keeps the unscaled scrollable grid behavior.
 *
 * @returns {void}
 */
function syncMobileMarkerGridLayout() {
  const viewport = dom.crossRoiViewport;
  const grid = dom.crossRoiGrid;
  if (!viewport || !grid) return;
  if (!state.runtime.mobileSingleViewerMode || grid.classList.contains("is-empty")) {
    viewport.style.height = "";
    grid.style.width = "";
    grid.style.height = "";
    grid.style.setProperty("--mobile-marker-grid-scale", "1");
    return;
  }
  const intrinsicWidth = Math.max(1, Math.round(grid.scrollWidth || 1));
  const intrinsicHeight = Math.max(1, Math.round(grid.scrollHeight || 1));
  const availableWidth = Math.max(1, Math.round(viewport.clientWidth || 1));
  const scale = Math.min(1, availableWidth / intrinsicWidth);
  grid.style.width = `${intrinsicWidth}px`;
  grid.style.height = `${intrinsicHeight}px`;
  grid.style.setProperty("--mobile-marker-grid-scale", String(scale));
  viewport.style.height = `${Math.ceil(intrinsicHeight * scale)}px`;
}

/**
 * Keep the mobile Page card's aspect-ratio hint aligned with the loaded source image.
 *
 * @returns {void}
 */
function updateMobileRawAspectRatio() {
  const width = Math.max(1, Math.round(state.source.canvas?.width || 1));
  const height = Math.max(1, Math.round(state.source.canvas?.height || 1));
  dom.rawViewerCard?.style.setProperty("--mobile-raw-aspect", `${width} / ${height}`);
}

/**
 * Switch the active mobile viewer tab while leaving the desktop multi-panel view unchanged.
 *
 * The rerender is deferred one animation frame so hidden canvases are not resized while their
 * cards are still `display:none`.
 *
 * @param {string} view
 * @returns {void}
 */
function setActiveViewerTab(view) {
  state.runtime.activeViewerTab = view;
  syncResponsiveViewerUi();
  window.requestAnimationFrame(() => {
    rerenderPreviews();
  });
}

/**
 * Small local wrapper around the preview module's sequence-length logic.
 *
 * @returns {number}
 */
function getOrderedFrameCount() {
  return getPreviewOrderedFrameCount(state, readConfig);
}

/**
 * Return the number of source cells currently included in preview/export before ordering expands
 * them into ping-pong playback.
 *
 * @returns {number}
 */
function getIncludedSourceFrameCount() {
  const total = Math.max(0, state.geometry.frameCount || 0);
  if (total <= 0) return 0;
  const requested = Math.round(Number(readConfig().exportOptions.frameCountToExport) || total);
  return Math.max(1, Math.min(total, requested));
}

/**
 * Small local wrapper around the preview module's frame-order mapping.
 *
 * @param {number} previewIndex
 * @returns {number}
 */
function getOrderedFrameIndex(previewIndex) {
  return getPreviewOrderedFrameIndex(previewIndex, state, readConfig);
}

/**
 * Resolve the source-frame index currently shown in Preview.
 *
 * During paused arrow-key inspection, this deliberately ignores export/playback ordering so the
 * user can examine the physical frame grid directly. It still respects `Frames in Export`, since
 * omitted highest-indexed cells should disappear consistently from preview, exports, and rectified
 * sheet overlays.
 *
 * @returns {number}
 */
function getCurrentDisplayedFrameSourceIndex() {
  const frameCount = getIncludedSourceFrameCount();
  if (frameCount <= 0) return 0;
  if (state.preview.paused && state.preview.inspectingRawFrame) {
    return ((state.preview.frameIndex % frameCount) + frameCount) % frameCount;
  }
  return getOrderedFrameIndex(state.preview.frameIndex);
}

/**
 * Return the number of frames that should be emitted into exported files after loop repetition
 * is applied. The live preview intentionally ignores `Number of Loops`.
 *
 * @returns {number}
 */
function getExportOrderedFrameCount() {
  const singleLoopCount = getOrderedFrameCount();
  if (singleLoopCount <= 0) return 0;
  return singleLoopCount * Math.max(1, readConfig().exportOptions.loopCount || 1);
}

/**
 * Map an export-sequence index to the underlying source-frame index, repeating the preview-order
 * sequence for the requested number of loops.
 *
 * @param {number} exportIndex
 * @returns {number}
 */
function getExportOrderedFrameIndex(exportIndex) {
  const singleLoopCount = getOrderedFrameCount();
  if (singleLoopCount <= 0) return 0;
  const localIndex = ((exportIndex % singleLoopCount) + singleLoopCount) % singleLoopCount;
  return getOrderedFrameIndex(localIndex);
}

/**
 * Step up or down within the valid source cells of the current physical column.
 *
 * When `Frames in Export` omits highest-indexed cells, the last physical row may be incomplete.
 * Vertical paused-grid inspection should wrap only across the valid cells that remain in the
 * current column, rather than wrapping modulo the truncated linear frame count.
 *
 * @param {number} sourceIndex
 * @param {number} rowStep
 * @returns {number}
 */
function getVerticallySteppedSourceIndex(sourceIndex, rowStep) {
  const frameCount = getIncludedSourceFrameCount();
  const cols = Math.max(1, state.geometry.alignmentInfo?.cols || 1);
  if (frameCount <= 0) return 0;
  if (cols <= 1) {
    return ((sourceIndex + rowStep + frameCount) % frameCount + frameCount) % frameCount;
  }
  const col = ((sourceIndex % cols) + cols) % cols;
  const columnIndices = [];
  for (let index = col; index < frameCount; index += cols) {
    columnIndices.push(index);
  }
  if (columnIndices.length <= 1) {
    return columnIndices[0] ?? sourceIndex;
  }
  const currentPos = Math.max(0, columnIndices.indexOf(sourceIndex));
  const nextPos = ((currentPos + rowStep) % columnIndices.length + columnIndices.length) % columnIndices.length;
  return columnIndices[nextPos];
}

/**
 * Draw the current preview frame via the dedicated preview controller.
 *
 * @returns {void}
 */
function drawCurrentGifPreview() {
  updateMobilePreviewAspectRatio();
  drawPreviewFrame({ dom, state, getAdjustedFrameCanvas, getDisplayFrameIndex: getCurrentDisplayedFrameSourceIndex });
  if (state.preview.rectifiedCanvas) {
    renderRectifiedPreview(state.preview.rectifiedCanvas);
  }
}

/**
 * Return the current temporary scrub delta for the post-rotation slider.
 *
 * The displayed rectified preview already includes the last processed Post-Rotation value. During
 * scrubbing, preview only the difference between the current slider value and that committed
 * processed rotation so the drag path does not double-apply the effect.
 *
 * @returns {number}
 */
function getPostRotationPreviewDeg() {
  const sliderDeg = Math.max(
    -1.1,
    Math.min(
      1.1,
      Number.isFinite(Number(dom.postRotation?.value))
        ? Number(dom.postRotation.value)
        : SETTINGS_DEFAULTS.detection.postRotationDeg
    )
  );
  return sliderDeg - (Number(state.runtime.appliedPostRotationDeg) || 0);
}

/**
 * Rotate one canvas-space point around the canvas center.
 *
 * @param {{x:number,y:number}} point
 * @param {number} width
 * @param {number} height
 * @param {number} radians
 * @returns {{x:number,y:number}}
 */
function rotateCanvasPointAroundCenter(point, width, height, radians) {
  const cx = width * 0.5;
  const cy = height * 0.5;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: cx + (dx * cos) - (dy * sin),
    y: cy + (dx * sin) + (dy * cos),
  };
}

/**
 * Estimate a representative border color for preview-only rotation fills.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {string}
 */
function getPreviewCanvasBorderFillStyle(canvas) {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
    return "rgb(245, 245, 245)";
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "rgb(245, 245, 245)";
  const width = canvas.width;
  const height = canvas.height;
  const bandRows = Math.min(2, height);
  const bandCols = Math.min(2, width);
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  const accumulateRowBand = (yStart, rows) => {
    if (rows <= 0) return;
    const data = ctx.getImageData(0, yStart, width, rows).data;
    for (let i = 0; i < data.length; i += 4) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
      count++;
    }
  };
  const accumulateColBand = (xStart, cols) => {
    if (cols <= 0) return;
    const data = ctx.getImageData(xStart, 0, cols, height).data;
    for (let i = 0; i < data.length; i += 4) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
      count++;
    }
  };
  accumulateRowBand(0, bandRows);
  accumulateRowBand(Math.max(0, height - bandRows), bandRows);
  accumulateColBand(0, bandCols);
  accumulateColBand(Math.max(0, width - bandCols), bandCols);
  if (count <= 0) return "rgb(245, 245, 245)";
  return `rgb(${Math.round(rSum / count)}, ${Math.round(gSum / count)}, ${Math.round(bSum / count)})`;
}

/**
 * Build or reuse the preview-scale rotated rectified canvas used only while scrubbing Post-Rotation.
 *
 * `rotationDeg` is the live scrub delta relative to the last processed rectified image, not an
 * absolute replacement rotation. That keeps the preview aligned with whatever Post-Rotation value
 * has already been committed by the last full pipeline run.
 *
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {number} rotationDeg
 * @returns {HTMLCanvasElement}
 */
function getPostRotationPreviewCanvas(sourceCanvas, rotationDeg) {
  if (
    state.preview.postRotationPreviewCanvas &&
    state.preview.postRotationPreviewSourceCanvas === sourceCanvas &&
    Math.abs(state.preview.postRotationPreviewDeg - rotationDeg) < 1e-9
  ) {
    return state.preview.postRotationPreviewCanvas;
  }
  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = sourceCanvas.width;
  previewCanvas.height = sourceCanvas.height;
  const ctx = previewCanvas.getContext("2d");
  // Positive canvas rotation now matches the UI convention: positive Post-Rotation feels clockwise.
  const radians = rotationDeg * (Math.PI / 180);
  ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  ctx.fillStyle = getPreviewCanvasBorderFillStyle(sourceCanvas);
  ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  ctx.save();
  ctx.translate(previewCanvas.width * 0.5, previewCanvas.height * 0.5);
  ctx.rotate(radians);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, -sourceCanvas.width * 0.5, -sourceCanvas.height * 0.5);
  ctx.restore();
  state.preview.postRotationPreviewCanvas = previewCanvas;
  state.preview.postRotationPreviewSourceCanvas = sourceCanvas;
  state.preview.postRotationPreviewDeg = rotationDeg;
  return previewCanvas;
}

/**
 * Clear the markerless paper-backdrop CSS variable so fallback styling applies again.
 *
 * @returns {void}
 */
function clearMarkerlessPaperBackdropColor() {
  document.body.style.removeProperty("--markerless-paper-backdrop");
}

/**
 * Estimate a representative paper color from a thin border sample.
 *
 * This helper is intentionally retained from an earlier backdrop-color experiment even though it
 * is no longer called at runtime. Keeping it around preserves the paper-sampling logic in case
 * that UI treatment is revisited later.
 *
 * @param {HTMLCanvasElement | null} canvas
 * @returns {void}
 */
function updateMarkerlessPaperBackdropColor(canvas) {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
    clearMarkerlessPaperBackdropColor();
    return;
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    clearMarkerlessPaperBackdropColor();
    return;
  }
  const width = canvas.width;
  const height = canvas.height;
  const bandRows = Math.min(2, height);
  const bandCols = Math.min(2, width);
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;

  const accumulateRowBand = (yStart, rows) => {
    if (rows <= 0) return;
    const data = ctx.getImageData(0, yStart, width, rows).data;
    for (let i = 0; i < data.length; i += 4) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
      count++;
    }
  };
  const accumulateColBand = (xStart, cols, yStart, rows) => {
    if (cols <= 0 || rows <= 0) return;
    const data = ctx.getImageData(xStart, yStart, cols, rows).data;
    for (let i = 0; i < data.length; i += 4) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
      count++;
    }
  };

  accumulateRowBand(0, bandRows);
  if (height > bandRows) {
    accumulateRowBand(Math.max(0, height - bandRows), bandRows);
  }

  const middleY = bandRows;
  const middleRows = Math.max(0, height - (bandRows * 2));
  if (middleRows > 0) {
    accumulateColBand(0, bandCols, middleY, middleRows);
    if (width > bandCols) {
      accumulateColBand(Math.max(0, width - bandCols), bandCols, middleY, middleRows);
    }
  }

  if (count <= 0) {
    clearMarkerlessPaperBackdropColor();
    return;
  }

  const avgR = Math.max(0, Math.min(255, Math.round(rSum / count) - 20));
  const avgG = Math.max(0, Math.min(255, Math.round(gSum / count) - 20));
  const avgB = Math.max(0, Math.min(255, Math.round(bSum / count) - 20));
  document.body.style.setProperty("--markerless-paper-backdrop", `rgb(${avgR}, ${avgG}, ${avgB})`);
}

/**
 * Release cached OpenCV source mats that are tied to the currently loaded raw image.
 *
 * The lightweight Page Detection Threshold preview reuses these mats so slider drags do not keep
 * re-reading the source canvas or redoing full-image grayscale conversion.
 *
 * @returns {void}
 */
function releaseSourceCvCaches() {
  if (state.source.grayMat) {
    state.source.grayMat.delete();
    state.source.grayMat = null;
  }
  if (state.source.previewGrayMat) {
    state.source.previewGrayMat.delete();
    state.source.previewGrayMat = null;
  }
  state.source.previewScale = 1;
}

/**
 * Ensure that the raw source image has cached OpenCV mats ready for lightweight page-boundary
 * previewing while the threshold-offset slider is dragged.
 *
 * Keep only grayscale caches here. The old persistent `state.source.cvMat` raw RGBA mat was
 * removed to lower peak memory on large scans; if some future feature truly needs a reusable
 * color source mat again, this helper is the right place to restore it.
 *
 * @returns {{grayMat: cv.Mat, previewGrayMat: cv.Mat, previewScale: number} | null}
 */
function ensureSourceCvCaches() {
  if (!state.runtime.cvReady || !state.source.image) return null;
  if (!state.source.grayMat) {
    const sourceCvMat = cv.imread(state.source.canvas);
    state.source.grayMat = new cv.Mat();
    try {
      cv.cvtColor(sourceCvMat, state.source.grayMat, cv.COLOR_RGBA2GRAY);
    } finally {
      sourceCvMat.delete();
    }
  }
  if (!state.source.previewGrayMat) {
    const sourceWidth = state.source.canvas.width;
    const sourceHeight = state.source.canvas.height;
    const sourceLongEdge = Math.max(sourceWidth, sourceHeight);
    const previewScale =
      sourceLongEdge > LIVE_THRESHOLD_PREVIEW_MAX_LONG_EDGE_PX
        ? LIVE_THRESHOLD_PREVIEW_MAX_LONG_EDGE_PX / sourceLongEdge
        : 1;
    state.source.previewScale = previewScale;
    if (previewScale < 1) {
      const previewWidth = Math.max(1, Math.round(sourceWidth * previewScale));
      const previewHeight = Math.max(1, Math.round(sourceHeight * previewScale));
      state.source.previewGrayMat = new cv.Mat();
      cv.resize(
        state.source.grayMat,
        state.source.previewGrayMat,
        new cv.Size(previewWidth, previewHeight),
        0,
        0,
        cv.INTER_AREA
      );
    } else {
      state.source.previewGrayMat = state.source.grayMat.clone();
    }
  }
  return {
    grayMat: state.source.grayMat,
    previewGrayMat: state.source.previewGrayMat,
    previewScale: state.source.previewScale,
  };
}

/**
 * Recompute just the page boundary and redraw the Page Corners panel while Page Detection Threshold is dragged.
 *
 * This intentionally skips page warp, grid detection, marker alignment, and frame extraction. The
 * fast downscaled preview can produce false negatives near threshold edge cases, so failures are
 * retried at full source resolution before the UI shows a page-boundary warning.
 *
 * @returns {void}
 */
function previewPageBoundaryForThresholdOffset() {
  if (!state.runtime.cvReady || !state.source.image || state.processing.active) return;
  // The previous full-pipeline status may describe a value the user has already scrubbed past.
  dom.statusText.textContent = "";
    const config = readConfig();
    const explicitManualContour = getManualPageContourForProcessing();
    if (explicitManualContour) {
      state.source.rawPageContour = explicitManualContour.map((point) => ({ x: point.x, y: point.y }));
      state.source.pageQuadSource = "manual-override-preview";
      state.source.thresholdPreviewPageContour = null;
      state.source.thresholdPreviewSignature = "";
    updatePageGridDetectionHeading(false);
    renderRawPreview();
    return;
  }
  try {
    const cachedSource = ensureSourceCvCaches();
    if (!cachedSource) return;
    const useInvertedMarkerVision = config.alignmentPipeline === "markers" && config.lightOnDarkDesign;
    /**
     * Run page-boundary detection on a grayscale source mat and return points in that mat's scale.
     *
     * @param {cv.Mat} sourceMat
     * @param {number} sourceScale
     * @returns {{threshVal:number,pageQuadPoints:{x:number,y:number}[] | null,pageAreaPct:number | null,failureReason:string,sourceScale:number,width:number,height:number}}
     */
    const runBoundaryPreview = (sourceMat, sourceScale) => {
      const workingMat = sourceMat.clone();
      try {
        if (useInvertedMarkerVision) {
          // Match the preview path to the full marker pipeline for light-on-dark inputs.
          cv.bitwise_not(workingMat, workingMat);
        }
        const result = previewPageBoundary(
          workingMat,
          workingMat.cols,
          workingMat.rows,
          config.thresholdMethod,
          config.thresholdOffset
        );
        return { ...result, sourceScale, width: workingMat.cols, height: workingMat.rows };
      } finally {
        workingMat.delete();
      }
    };

    const fastPreview = runBoundaryPreview(cachedSource.previewGrayMat, cachedSource.previewScale);
    const fastPreviewFoundQuad = Array.isArray(fastPreview.pageQuadPoints) && fastPreview.pageQuadPoints.length === 4;
    const preview = fastPreviewFoundQuad
      ? fastPreview
      : runBoundaryPreview(cachedSource.grayMat, 1);
    const hasPageQuad = Array.isArray(preview.pageQuadPoints) && preview.pageQuadPoints.length === 4;
    const previewContour = hasPageQuad
      ? preview.pageQuadPoints.map((point) => ({
          x: point.x / preview.sourceScale,
          y: point.y / preview.sourceScale,
        }))
      : null;
    state.source.rawPageContour = previewContour;
    state.source.pageQuadSource = previewContour ? "threshold-preview-live" : "";
    state.source.thresholdPreviewPageContour = previewContour
      ? previewContour.map((point) => ({ x: point.x, y: point.y }))
      : null;
    state.source.thresholdPreviewSignature = hasPageQuad ? getPageBoundaryPreviewSignature(config) : "";
    updatePageGridDetectionHeading(!hasPageQuad);
    renderRawPreview();
  } catch (error) {
    state.source.rawPageContour = null;
    state.source.pageQuadSource = "";
    state.source.thresholdPreviewPageContour = null;
    state.source.thresholdPreviewSignature = "";
    renderRawPreview();
    updatePageGridDetectionHeading(true);
    console.error(error);
  }
}

/**
 * Start the preview loop via the dedicated preview controller.
 *
 * @returns {void}
 */
function startAnimationPreviewLoop() {
  startPreviewLoop({ state, readConfig, drawCurrentGifPreview });
}

/**
 * Rerender visible previews after display-only changes such as resize.
 *
 * @returns {void}
 */
function rerenderPreviews() {
  rerenderPreviewSurfaces({ state, renderRawPreview, renderRectifiedPreview, drawCurrentGifPreview });
}

/**
 * Small local wrapper around the ui-controls module's tooltip state toggler.
 *
 * @param {boolean} enabled
 * @returns {void}
 */
function setTooltipsEnabled(enabled) {
  applyTooltipState({
    dom,
    state,
    enabled,
    previewTooltipText: TOOLTIP_TEXT["#gifPreviewCanvas"] || "",
  });
  syncRawPhotoHeadingLink();
  syncRectifiedSheetHeadingLink();
  if (state.geometry.alignmentInfo) {
    renderCrossRoiGrid(state.geometry.alignmentInfo);
  }
}

/**
 * Small local wrapper around the load controller's busy-state sync.
 *
 * @param {boolean} busy
 * @returns {void}
 */
function setBusyState(busy) {
  syncBusyState(dom, state, busy);
}

/**
 * Toggle a body-level cursor cue while geometry-affecting CV work is queued or running.
 *
 * @param {boolean} active
 * @returns {void}
 */
function setGeometryProcessingCursor(active) {
  document.body.classList.toggle("geometry-processing", !!active);
  syncPreviewBusyIndicator();
}

/**
 * Keep the Preview header spinner aligned with any busy state that can stall or delay playback.
 *
 * This includes source-image loading, geometry-processing rebuilds, and the chunked stabilization
 * comparison job whose own progress UI lives in Status. It also includes final preview-frame cache
 * warmup: the CV pipeline may be complete while output-sized canvases are still being generated.
 *
 * @returns {void}
 */
function syncPreviewBusyIndicator() {
  if (!dom.previewBusy) return;
  document.body.classList.toggle("stabilization-processing", !!state.processing.stabilizationMeasurementActive);
  document.body.classList.toggle("preview-warmup-processing", !!state.processing.previewWarmupActive);
  dom.previewBusy.hidden = !(
    !!state.runtime.busy ||
    document.body.classList.contains("geometry-processing") ||
    document.body.classList.contains("stabilization-processing") ||
    document.body.classList.contains("preview-warmup-processing") ||
    !!state.processing.stabilizationMeasurementActive ||
    !!state.processing.previewWarmupActive
  );
}

const ENABLE_TEMP_PROCESS_TIMING = false;
const MARKERLESS_DEBUG_AUTOHIDE_MS = 20_000;
let activeTimingProfile = null;
let lastBaseStatusText = "";
let lastProcessTimingSummary = "";
let lastWarmupTimingSummary = "";
let lastHeavyPathTimingSummary = "";

/**
 * Begin collecting temporary timing stats for one synchronous processing phase.
 *
 * @param {string} label
 * @returns {{label:string,start:number,sections:Map<string,{total:number,count:number,max:number}>}|null}
 */
function beginTimingProfile(label) {
  if (!ENABLE_TEMP_PROCESS_TIMING) return null;
  const profile = {
    label,
    start: performance.now(),
    sections: new Map(),
  };
  activeTimingProfile = profile;
  return profile;
}

/**
 * Record one measured sub-step inside the currently active temporary timing profile.
 *
 * @param {string} key
 * @param {number} durationMs
 * @returns {void}
 */
function recordTimingSample(key, durationMs) {
  if (!activeTimingProfile) return;
  const entry = activeTimingProfile.sections.get(key) || { total: 0, count: 0, max: 0 };
  entry.total += durationMs;
  entry.count += 1;
  entry.max = Math.max(entry.max, durationMs);
  activeTimingProfile.sections.set(key, entry);
}

/**
 * Time one synchronous helper only while a temporary timing profile is active.
 *
 * @template T
 * @param {string} key
 * @param {() => T} fn
 * @returns {T}
 */
function timeProfiled(key, fn) {
  if (!activeTimingProfile) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    recordTimingSample(key, performance.now() - start);
  }
}

/**
 * Finish a temporary timing profile and return a compact multiline summary for Status.
 *
 * @param {{label:string,start:number,sections:Map<string,{total:number,count:number,max:number}>}|null} profile
 * @returns {string}
 */
function finishTimingProfile(profile) {
  if (!profile) return "";
  const totalMs = performance.now() - profile.start;
  if (activeTimingProfile === profile) {
    activeTimingProfile = null;
  }
  const lines = [`${profile.label}: ${totalMs.toFixed(0)} ms`];
  const sectionEntries = [...profile.sections.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 8);
  for (const [key, entry] of sectionEntries) {
    const detail = entry.count > 1
      ? `${entry.total.toFixed(0)} ms (${entry.count}×, max ${entry.max.toFixed(0)} ms)`
      : `${entry.total.toFixed(0)} ms`;
    lines.push(`- ${key}: ${detail}`);
  }
  return lines.join("\n");
}

/**
 * Combine the base localized status text with the current temporary timing summaries.
 *
 * @param {string} baseText
 * @returns {string}
 */
function buildStatusWithTiming(baseText) {
  if (!ENABLE_TEMP_PROCESS_TIMING) return baseText;
  const extras = [lastProcessTimingSummary, lastWarmupTimingSummary, lastHeavyPathTimingSummary].filter(Boolean);
  if (!extras.length) return baseText;
  return `${baseText}\n\nTiming (temporary):\n${extras.join("\n")}`;
}

/**
 * Use compact Rectified Grid header labels when both background jobs are reporting progress.
 *
 * @returns {void}
 */
function updateRectifiedProgressCompactLabels() {
  const stabilizationProgress = dom.rectifiedSheetProgress;
  const frameProgress = dom.rectifiedSheetFrameProgress;
  if (!stabilizationProgress || !frameProgress) return;

  const stabilizationActive = !!state.processing.stabilizationMeasurementActive;
  const frameWarmupActive = !!state.processing.previewWarmupActive;
  if (!stabilizationActive || !frameWarmupActive) return;

  const stabilizationCompleted = state.processing.stabilizationMeasurementProgressCompleted || 0;
  const stabilizationTotal = Math.max(1, state.processing.stabilizationMeasurementProgressTotal || 1);
  const frameCompleted = state.processing.previewWarmupProgressCompleted || 0;
  const frameTotal = Math.max(1, state.processing.previewWarmupProgressTotal || 1);
  stabilizationProgress.textContent = t("status.stabilizingProgressCompact", {
    completed: stabilizationCompleted,
    total: stabilizationTotal,
  });
  frameProgress.textContent = t("status.processingFramesProgressCompact", {
    completed: frameCompleted,
    total: frameTotal,
  });
}

/**
 * Keep the temporary pairwise-measurement progress bar in sync with current work.
 *
 * @returns {void}
 */
function updateStabilizationProgressUi() {
  const container = dom.statusStabilizationProgress;
  const label = dom.statusStabilizationProgressLabel;
  const bar = dom.statusStabilizationProgressBar;
  const rectifiedProgress = dom.rectifiedSheetProgress;
  if (!container || !label || !bar) return;
  const active = !!state.processing.stabilizationMeasurementActive;
  syncPreviewBusyIndicator();
  container.hidden = !active;
  if (rectifiedProgress) {
    rectifiedProgress.hidden = !active;
  }
  if (!active) return;
  const completed = state.processing.stabilizationMeasurementProgressCompleted || 0;
  const total = Math.max(1, state.processing.stabilizationMeasurementProgressTotal || 1);
  const progressText = t("status.computingStabilizationProgress", { completed, total });
  label.textContent = progressText;
  if (rectifiedProgress) {
    rectifiedProgress.textContent = progressText;
  }
  bar.max = total;
  bar.value = Math.max(0, Math.min(total, completed));
  updateRectifiedProgressCompactLabels();
}

/**
 * Keep the temporary output-frame generation progress bar in sync with current warmup work.
 *
 * @returns {void}
 */
function updatePreviewFrameProgressUi() {
  const container = dom.statusFrameProgress;
  const label = dom.statusFrameProgressLabel;
  const bar = dom.statusFrameProgressBar;
  const rectifiedProgress = dom.rectifiedSheetFrameProgress;
  if (!container || !label || !bar) return;
  const active = !!state.processing.previewWarmupActive;
  syncPreviewBusyIndicator();
  container.hidden = !active;
  if (rectifiedProgress) {
    rectifiedProgress.hidden = !active;
  }
  if (!active) return;
  const completed = state.processing.previewWarmupProgressCompleted || 0;
  const total = Math.max(1, state.processing.previewWarmupProgressTotal || 1);
  const progressText = t("status.processingFramesProgress", { completed, total });
  label.textContent = progressText;
  if (rectifiedProgress) {
    rectifiedProgress.textContent = progressText;
  }
  bar.max = total;
  bar.value = Math.max(0, Math.min(total, completed));
  updateRectifiedProgressCompactLabels();
}

/**
 * Refresh the Status panel so temporary progress text and bars stay visible.
 *
 * @returns {void}
 */
function refreshStatusDisplay() {
  updateStabilizationProgressUi();
  updatePreviewFrameProgressUi();
  if (lastBaseStatusText) {
    setStatus(buildStatusWithTiming(lastBaseStatusText));
  }
}

/**
 * Time one shared heavy rebuild path and append its summary to Status.
 *
 * This is used for expensive cache-rebuild/redraw paths that do not flow through
 * `processCurrentImage()`, such as markerless phase release and crop/resampling frame rebuilds.
 *
 * @template T
 * @param {string} label
 * @param {() => T} fn
 * @returns {T}
 */
function runTimedHeavyPath(label, fn) {
  if (!ENABLE_TEMP_PROCESS_TIMING) return fn();
  const profile = beginTimingProfile(label);
  try {
    return fn();
  } finally {
    lastHeavyPathTimingSummary = finishTimingProfile(profile);
    if (lastBaseStatusText) {
      setStatus(buildStatusWithTiming(lastBaseStatusText));
    }
  }
}

/**
 * Yield one browser paint so UI updates land before kicking off heavier work.
 *
 * @returns {Promise<void>}
 */
async function waitForNextPaint() {
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Cancel any in-flight chunked pairwise stabilization measurement and hide its temporary UI.
 *
 * @returns {void}
 */
function cancelStabilizationMeasurement() {
  state.processing.stabilizationMeasurementToken += 1;
  state.processing.stabilizationMeasurementActive = false;
  state.processing.stabilizationMeasurementProgressCompleted = 0;
  state.processing.stabilizationMeasurementProgressTotal = 0;
  state.processing.stabilizationMeasurementRedrawPending = false;
  state.processing.stabilizationMeasurementPromise = null;
  updateStabilizationProgressUi();
}

/**
 * Cancel any queued background generation of output-sized preview frames.
 *
 * @returns {void}
 */
function cancelPreviewFrameWarmup() {
  state.processing.previewWarmupToken += 1;
  if (state.processing.previewWarmupRaf) {
    window.cancelAnimationFrame(state.processing.previewWarmupRaf);
  }
  state.processing.previewWarmupActive = false;
  state.processing.previewWarmupProgressCompleted = 0;
  state.processing.previewWarmupProgressTotal = 0;
  state.processing.previewWarmupRaf = 0;
  updatePreviewFrameProgressUi();
}

/**
 * Return whether final output-frame warmup should wait for async stabilization measurements.
 *
 * When Neighbor Comparison is enabled but its pairwise shifts are not ready yet, warming all
 * preview frames would build an unstabilized cache that must be thrown away moments later.
 *
 * @returns {boolean}
 */
function previewFrameWarmupShouldWaitForStabilization() {
  const config = readConfig();
  if (!config.stabilizationEnabled) return false;
  if ((config.stabilizationStrengthPct || 0) <= 0) return false;
  if (config.stabilizationMethod !== "pairwise-cyclic") return false;
  return !state.frames.stabilizationPairwise?.length;
}

/**
 * Build selected final preview/export frame outputs in small RAF slices.
 *
 * This is shared by whole-sequence warmup and targeted marker-override warmup. It deliberately
 * warms source-frame indices rather than preview-sequence indices because ordering modes can repeat
 * or reverse the same underlying source frame.
 *
 * @param {number[]} sourceIndices
 * @param {number} requestId
 * @returns {void}
 */
function schedulePreviewFrameWarmupForSourceIndices(sourceIndices, requestId) {
  cancelPreviewFrameWarmup();
  if (previewFrameWarmupShouldWaitForStabilization()) return;
  const frameCount = getIncludedSourceFrameCount();
  if (frameCount <= 0) return;

  const orderedSourceIndices = [];
  const seen = new Set();
  for (const sourceIndex of sourceIndices) {
    if (sourceIndex >= 0 && sourceIndex < frameCount && !seen.has(sourceIndex)) {
      seen.add(sourceIndex);
      orderedSourceIndices.push(sourceIndex);
    }
  }
  if (!orderedSourceIndices.length) return;

  const token = state.processing.previewWarmupToken + 1;
  state.processing.previewWarmupToken = token;
  state.processing.previewWarmupActive = true;
  state.processing.previewWarmupProgressCompleted = 0;
  state.processing.previewWarmupProgressTotal = orderedSourceIndices.length;
  updatePreviewFrameProgressUi();

  let cursor = 0;
  const step = () => {
    if (token !== state.processing.previewWarmupToken || requestId !== state.processing.requestId) {
      return;
    }
    try {
      const start = performance.now();
      do {
        getAdjustedFrameCanvas(orderedSourceIndices[cursor]);
        cursor += 1;
        state.processing.previewWarmupProgressCompleted = cursor;
      } while (cursor < orderedSourceIndices.length && performance.now() - start < 8);
      updatePreviewFrameProgressUi();

      if (cursor < orderedSourceIndices.length) {
        state.processing.previewWarmupRaf = window.requestAnimationFrame(step);
        return;
      }
    } catch (error) {
      console.error(error);
    }

    state.processing.previewWarmupActive = false;
    state.processing.previewWarmupProgressCompleted = Math.min(cursor, orderedSourceIndices.length);
    state.processing.previewWarmupRaf = 0;
    updatePreviewFrameProgressUi();
  };

  state.processing.previewWarmupRaf = window.requestAnimationFrame(step);
}

/**
 * Warm every source frame currently reachable through preview/export ordering.
 *
 * @param {number} requestId
 * @returns {void}
 */
function schedulePreviewFrameWarmup(requestId) {
  const sourceIndices = [];
  const orderedFrameCount = getOrderedFrameCount();
  for (let previewIndex = 0; previewIndex < orderedFrameCount; previewIndex += 1) {
    sourceIndices.push(getOrderedFrameIndex(previewIndex));
  }
  schedulePreviewFrameWarmupForSourceIndices(sourceIndices, requestId);
}

/**
 * Warm final preview/export frames for the currently active processing generation.
 *
 * @returns {void}
 */
function scheduleCurrentPreviewFrameWarmup() {
  schedulePreviewFrameWarmup(state.processing.requestId);
}

/**
 * Warm selected source frames for the currently active processing generation.
 *
 * @param {number[]} sourceIndices
 * @returns {void}
 */
function scheduleCurrentPreviewFrameWarmupForSourceIndices(sourceIndices) {
  schedulePreviewFrameWarmupForSourceIndices(sourceIndices, state.processing.requestId);
}

/**
 * Small local wrapper around the drag-assets module's rectified drag-URL cleanup.
 *
 * @returns {void}
 */
function releaseRectifiedDragUrl() {
  releaseRectifiedDragAsset(state);
}

/**
 * Revoke the cached full-resolution rectified-sheet URL used by the heading link.
 *
 * @returns {void}
 */
function releaseRectifiedFullResUrl() {
  if (!state.preview.rectifiedFullResUrl) return;
  URL.revokeObjectURL(state.preview.rectifiedFullResUrl);
  state.preview.rectifiedFullResUrl = "";
}

/**
 * Small local wrapper around the drag-assets module's rectified drag-asset builder.
 *
 * @param {HTMLCanvasElement | null} rectifiedCanvas
 * @returns {void}
 */
function primeRectifiedDragAsset(rectifiedCanvas) {
  buildRectifiedDragAsset(state, rectifiedCanvas);
}

/**
 * Small local wrapper around the drag-assets module's generic canvas drag hookup.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {() => {url?:string, filename:string, mimeType:string, canvas?:HTMLCanvasElement | null} | null} getDragAsset
 * @returns {void}
 */
function makeCanvasDraggable(canvas, getDragAsset) {
  attachCanvasDragAsset(canvas, getDragAsset);
}

/**
 * Small local wrapper around the drag-assets module's exported-GIF drag hookup.
 *
 * @returns {void}
 */
function makeGifImageDraggable() {
  attachGifImageDragAsset(dom, state);
}

/**
 * Small local wrapper around the drag-assets module's live-preview drag cue hookup.
 *
 * @returns {void}
 */
function makeLivePreviewDragCue() {
  attachLivePreviewDragCue(dom, state);
}

/**
 * Clear all derived preview surfaces so a newly loaded source image never shows stale results.
 *
 * @returns {void}
 */
function clearDerivedPreviews() {
  cancelPreviewFrameWarmup();
  releaseRectifiedCvCache();
  state.runtime.appliedPostRotationDeg = 0;
  state.preview.rectifiedCanvas = null;
  state.preview.rectifiedDiagnosticSourceCanvas = null;
  state.preview.rectifiedDiagnosticDirty = true;
  state.preview.postRotationPreviewCanvas = null;
  state.preview.postRotationPreviewSourceCanvas = null;
  state.preview.postRotationPreviewDeg = 0;
  releaseRectifiedDragUrl();
  releaseRectifiedFullResUrl();
  state.preview.rectifiedFullResBuildId += 1;
  state.preview.rectifiedDragBuildId += 1;
  state.geometry.baseRectifiedCanvas = null;
  state.geometry.baseRectifiedPageCanvas = null;
  state.geometry.baseRectifiedPageWidth = 0;
  state.geometry.baseRectifiedPageHeight = 0;
  state.geometry.rectifiedDownloadUsesRawSource = false;
  state.geometry.pagePreviewGridQuad = null;
  state.geometry.pagePreviewGridBounds = null;
  state.geometry.alignmentInfo = null;
  state.geometry.frameCount = 0;
  state.geometry.manualMarkerOverrides.clear();
  state.preview.activeEditedMarker = null;
  state.runtime.markerEditingEnabled = false;
  state.runtime.markerBlobDebugVisible = false;
  state.frames.base = [];
  state.frames.baseOutputEpoch = [];
  state.frames.stabilizedCache.clear();
  state.frames.stabilizedOutputEpoch.clear();
  state.frames.phaseAdjustedCache.clear();
  state.frames.stabilizationMatchData = null;
  state.frames.stabilizationPairwise = null;
  state.frames.stabilizationAverageReference = null;
  state.frames.stabilizationOffsets = null;
  state.frames.adjustedCache.clear();
  state.frames.adjustedOutputEpoch.clear();
  state.frames.outputEpoch = 0;
  state.preview.frameIndex = 0;
  state.preview.inspectingRawFrame = false;
  state.preview.showRectifiedDiagnostic = false;
  updateRectifiedSheetHeading();

  const rectifiedCtx = dom.rectifiedCanvas.getContext("2d");
  resizeCanvasToBox(dom.rectifiedCanvas);
  rectifiedCtx.clearRect(0, 0, dom.rectifiedCanvas.width, dom.rectifiedCanvas.height);
  dom.rectifiedCanvas.parentElement?.classList.add("is-empty");

  const previewCtx = dom.gifPreviewCanvas.getContext("2d");
  resizeCanvasToBox(dom.gifPreviewCanvas);
  previewCtx.clearRect(0, 0, dom.gifPreviewCanvas.width, dom.gifPreviewCanvas.height);
  dom.gifPreviewCanvas.parentElement?.classList.add("is-empty");

  dom.crossRoiGrid.innerHTML = "";
  dom.crossRoiGrid.classList.add("is-empty");
  dom.crossRoiViewport?.classList.add("is-empty");
  syncMobileMarkerGridLayout();
  updateExportControlsAvailability(true);
  syncMarkerEditingUi();
  updatePreviewPlayPauseButton();
  updateAnimationPreviewHeading();
  updateExportButtonLabel();
}

/**
 * Clear every preview panel back to its striped empty state while a new source image is loading.
 *
 * This prevents stale raw/rectified/animation content from lingering between source-image loads.
 *
 * @returns {void}
 */
function clearAllPreviews() {
  releaseSourceCvCaches();
  state.source.rawPageContour = null;
  state.source.pageQuadSource = "";
  state.source.manualPageContour = null;
  state.source.thresholdPreviewPageContour = null;
  state.source.thresholdPreviewSignature = "";
  state.runtime.pageCornerEditingEnabled = false;
  state.preview.activePageCornerDrag = null;
  state.preview.paused = false;
  syncPageCornerEditingUi();
  updatePreviewPlayPauseButton();

  const rawCtx = dom.rawCanvas.getContext("2d");
  resizeCanvasToBox(dom.rawCanvas);
  rawCtx.clearRect(0, 0, dom.rawCanvas.width, dom.rawCanvas.height);
  dom.rawCanvas.parentElement?.classList.add("is-empty");

  clearDerivedPreviews();
}

/**
 * Blank all downstream panels after page-detection failure while keeping the source image and any
 * saved manual marker overrides available for a later successful reprocess.
 *
 * This prevents Rectified Grid, Frame Alignment Markers, and Preview from showing stale
 * last-known-good results when the current settings no longer produce a valid page boundary.
 *
 * @returns {void}
 */
function clearDerivedOutputsForDetectionFailure() {
  cancelPreviewFrameWarmup();
  releaseRectifiedCvCache();
  state.runtime.appliedPostRotationDeg = 0;
  state.preview.rectifiedCanvas = null;
  state.preview.rectifiedDiagnosticSourceCanvas = null;
  state.preview.rectifiedDiagnosticDirty = true;
  state.preview.postRotationPreviewCanvas = null;
  state.preview.postRotationPreviewSourceCanvas = null;
  state.preview.postRotationPreviewDeg = 0;
  releaseRectifiedDragUrl();
  releaseRectifiedFullResUrl();
  state.preview.rectifiedFullResBuildId += 1;
  state.preview.rectifiedDragBuildId += 1;
  state.geometry.baseRectifiedCanvas = null;
  state.geometry.baseRectifiedPageCanvas = null;
  state.geometry.baseRectifiedPageWidth = 0;
  state.geometry.baseRectifiedPageHeight = 0;
  state.geometry.rectifiedDownloadUsesRawSource = false;
  state.geometry.pagePreviewGridQuad = null;
  state.geometry.pagePreviewGridBounds = null;
  state.geometry.alignmentInfo = null;
  state.geometry.frameCount = 0;
  state.runtime.markerEditingEnabled = false;
  state.runtime.markerBlobDebugVisible = false;
  state.frames.base = [];
  state.frames.baseOutputEpoch = [];
  state.frames.stabilizedCache.clear();
  state.frames.stabilizedOutputEpoch.clear();
  state.frames.phaseAdjustedCache.clear();
  state.frames.stabilizationMatchData = null;
  state.frames.stabilizationPairwise = null;
  state.frames.stabilizationAverageReference = null;
  state.frames.stabilizationOffsets = null;
  state.frames.adjustedCache.clear();
  state.frames.adjustedOutputEpoch.clear();
  state.frames.outputEpoch = 0;
  state.preview.frameIndex = 0;
  state.preview.inspectingRawFrame = false;
  state.preview.showRectifiedDiagnostic = false;
  updateRectifiedSheetHeading();

  const rectifiedCtx = dom.rectifiedCanvas.getContext("2d");
  resizeCanvasToBox(dom.rectifiedCanvas);
  rectifiedCtx.clearRect(0, 0, dom.rectifiedCanvas.width, dom.rectifiedCanvas.height);
  dom.rectifiedCanvas.parentElement?.classList.add("is-empty");

  const previewCtx = dom.gifPreviewCanvas.getContext("2d");
  resizeCanvasToBox(dom.gifPreviewCanvas);
  previewCtx.clearRect(0, 0, dom.gifPreviewCanvas.width, dom.gifPreviewCanvas.height);
  dom.gifPreviewCanvas.parentElement?.classList.add("is-empty");

  dom.crossRoiGrid.innerHTML = "";
  dom.crossRoiGrid.classList.add("is-empty");
  dom.crossRoiViewport?.classList.add("is-empty");
  syncMobileMarkerGridLayout();
  updateExportControlsAvailability(true);
  syncMarkerEditingUi();
  updatePreviewPlayPauseButton();
  updateAnimationPreviewHeading();
  updateExportButtonLabel();
}

/**
 * Bootstrap the application once the module is loaded.
 *
 * This wires both the desktop layout and the narrower-screen mobile layout. The responsive
 * reparenting of control groups happens later inside `syncResponsiveViewerUi()`.
 *
 * @returns {void}
 */
function init() {
  applyTranslations(document);
  attachUi();
  [
    dom.mobileControlTabLayout,
    dom.mobileControlTabPageGrid,
    dom.mobileControlTabAlignment,
    dom.mobileControlTabAppearance,
    dom.mobileControlTabCrop,
    dom.mobileControlTabExport,
  ].forEach((button) => {
    button?.addEventListener("click", () => {
      setActiveMobileControlTab(button.dataset.controlTab || "layout");
    });
  });
  initAccordionPanels();
  initializeTooltips();
  dom.statusGroup?.addEventListener("toggle", () => {
    if (state.runtime.mobileSingleViewerMode && dom.statusGroup) {
      dom.statusGroup.open = true;
    }
  });
  void populateDemoSelect();
  syncPaperPresetUi();
  syncAlignmentMarkerUi();
  syncMp4ExportUi();
  syncResponsiveViewerUi();
  syncPageCornerEditingUi();
  syncMarkerEditingUi();
  updatePageGridDetectionHeading(false);
  updateRectifiedSheetHeading();
  dom.togglePageCornerEditingButton?.addEventListener("click", togglePageCornerEditing);
  dom.clearPageCornerEditsButton?.addEventListener("click", clearPageCornerEdits);
  dom.thresholdOffsetRow?.addEventListener("pointerdown", () => {
    if (Array.isArray(state.source.manualPageContour) && state.source.manualPageContour.length === 4) {
      triggerPageCornerClearEditsAttention();
    }
  });
  attachRawPageCornerEditing();
  dom.rectifiedSheetHeadingText?.addEventListener("click", (event) => {
    if (state.preview.showRectifiedDiagnostic) {
      event.preventDefault();
      return;
    }
    if (state.geometry.rectifiedDownloadUsesRawSource) return;
    if (state.preview.rectifiedFullResUrl) return;
    event.preventDefault();
    downloadFullResRectifiedSheet();
  });
  dom.gifImage.classList.add("hidden");
  dom.gifImage.hidden = true;
  dom.gifImage.removeAttribute("src");
  updateAnimationPreviewHeading();
  updateExportButtonLabel();
  updatePreviewPlayPauseButton();
  updateExportControlsAvailability();
  state.runtime.pageBoundaryWarningVisible = false;

  if (typeof cv !== "undefined" && cv.onRuntimeInitialized) {
    cv.onRuntimeInitialized = onOpenCvReady;
  } else if (typeof cv !== "undefined") {
    onOpenCvReady();
  } else {
    setStatus(t("status.openCvNotLoaded"));
  }

  updateSliderReadouts();
  attachResizeHandler();
  startAnimationPreviewLoop();
  void initializeMp4Support();

  // Until the Phase 7 image strip exists, expose the active-image switch on a small dev handle so
  // per-frame per-image overrides can be exercised from the console. Phase 7 will call setActiveImage
  // directly from the strip wiring.
  window.plottimation = Object.assign(window.plottimation || {}, { setActiveImage });
}

/**
 * Small local wrapper around the ui-controls module's event wiring.
 *
 * @returns {void}
 */
function attachUi() {
  wireUiControls({
    dom,
    state,
    getPaperGeometrySignature,
    makeCanvasDraggable,
    makeRectifiedFilename,
    makeLivePreviewDragCue,
    makeGifImageDraggable,
    handleFile,
    loadSelectedDemo: (filename) => { void loadSelectedDemo(filename); },
    renderRectifiedPreview,
    resetAppearanceControls,
    resetTrimControls,
    resetExportControls,
    toggleTooltips: () => setTooltipsEnabled(!state.runtime.tooltipsEnabled),
    togglePreviewPaused: () => {
      if (dom.previewPlayPauseButton.disabled) return;
      if (state.export.url) {
        revokeGifUrl();
        state.preview.paused = true;
        state.preview.inspectingRawFrame = false;
        state.preview.lastTime = performance.now();
        updatePreviewPlayPauseButton();
        drawCurrentGifPreview();
        return;
      }
      state.preview.paused = !state.preview.paused;
      if (!state.preview.paused) {
        state.preview.inspectingRawFrame = false;
      }
      state.preview.lastTime = performance.now();
      updatePreviewPlayPauseButton();
      drawCurrentGifPreview();
    },
    stepPausedPreviewFrame: (direction) => {
      const frameCount = getIncludedSourceFrameCount();
      if (!state.preview.paused || frameCount <= 0) return;
      const currentSourceIndex = getCurrentDisplayedFrameSourceIndex();
      const cols = Math.max(1, state.geometry.alignmentInfo?.cols || 1);
      state.preview.inspectingRawFrame = true;
      if (Math.abs(direction) === cols) {
        state.preview.frameIndex = getVerticallySteppedSourceIndex(currentSourceIndex, Math.sign(direction) || 1);
      } else {
        state.preview.frameIndex = (currentSourceIndex + direction + frameCount) % frameCount;
      }
      drawCurrentGifPreview();
    },
    toggleMarkerBlobView,
    toggleMarkerlessPhaseDebug,
    toggleMarkerlessWorkingImage,
    setRectifiedPreviewMode,
    toggleMarkerEditing,
    clearMarkerEdits,
    syncOutputSizeFromWidthInput,
    syncOutputSizeFromHeightInput,
    swapManualOutputSizeForRotate90,
    previewPageBoundaryForThresholdOffset,
    syncPaperPresetUi,
    syncAlignmentMarkerUi,
    setActiveViewerTab,
    updateSliderReadouts,
    scheduleProcess,
    revokeGifUrl,
    invalidateAppearanceCache,
    invalidateStabilizationCache,
    invalidateStabilizedOutputCaches,
    invalidateStabilizationOffsetsCache,
    invalidateCurrentPreviewFrameCaches,
    invalidateCurrentPreviewStabilizationCaches,
    scheduleAppearancePreviewUpdate,
    scheduleStabilizationPreviewUpdate,
    scheduleMarkerlessPhasePreviewUpdate,
    schedulePostRotationPreviewUpdate,
    schedulePreviewFrameWarmup: scheduleCurrentPreviewFrameWarmup,
    runTimedHeavyPath,
    warmCurrentStabilizationMethod: scheduleCurrentStabilizationWarmup,
    beginStabilizationStrengthScrub,
    endStabilizationStrengthScrub,
    beginMarkerlessPhaseScrub,
    endMarkerlessPhaseScrub,
    beginSearchInsetPreviewOverride,
    endSearchInsetPreviewOverride,
    beginPostRotationScrub,
    endPostRotationScrub,
    finishPostRotationScrubIfUnchanged,
    commitActivePostRotationFromSlider,
    setActiveImage,
    isPerFrameModeActive,
    addPerFrameImages,
    clearAllPreviews,
    bumpFrameOutputEpoch,
    setGeometryProcessingCursor,
    cancelInFlightProcessing,
    invalidateFrameCaches,
    invalidateFrameOutputCaches,
    rebuildAllFrameOutputCaches,
    drawCurrentGifPreview,
    exportGif,
    exportMp4,
    exportZip,
    saveSettingsFile,
  });
}

/**
 * Small local wrapper around the ui-controls module's tooltip registration.
 *
 * @returns {void}
 */
function initializeTooltips() {
  registerTooltips({
    tooltipText: TOOLTIP_TEXT,
    state,
    dom,
    applyTooltipState: setTooltipsEnabled,
  });
}

/**
 * Detect WebCodecs-based MP4 export support after startup and refresh the relevant UI.
 *
 * This is asynchronous because `VideoEncoder.isConfigSupported(...)` is async. The rest of the app
 * can finish booting immediately and then reveal/enable MP4 controls once support is known.
 *
 * @returns {Promise<void>}
 */
async function initializeMp4Support() {
  try {
    const support = await detectMp4ExportSupport();
    state.runtime.mp4ExportSupported = support.supported;
    if (support.codec) {
      state.runtime.mp4Codec = support.codec;
    }
  } catch {
    state.runtime.mp4ExportSupported = false;
  }
  syncMp4ExportUi();
  updateExportControlsAvailability();
  setTooltipsEnabled(state.runtime.tooltipsEnabled);
}

/**
 * Apply persisted manual marker overrides to the freshly detected alignment result.
 *
 * Overrides are stored in rectified-sheet coordinates and replace the marker center used by
 * extraction, while the original auto-detection remains available in the tile metadata.
 *
 * @param {object | null} alignmentInfo
 * @returns {void}
 */
function applyManualMarkerOverrides(alignmentInfo) {
  if (!alignmentInfo) return;
  // Non-marker pipelines (markerless + per-frame) interpret corner overrides as post-stabilization
  // nudges, not in-place marker patches, so this marker-only fast path is skipped for both.
  if (readConfig().alignmentPipeline !== "markers") return;
  for (const [key, override] of state.geometry.manualMarkerOverrides.entries()) {
    const marker = alignmentInfo.markerLookup.get(key);
    const tile = alignmentInfo.crossRoiTileMap?.get(key);
    if (marker) {
      marker.detectedX = override.x;
      marker.detectedY = override.y;
      marker.accepted = true;
      marker.manualOverride = true;
    }
    if (tile) {
      tile.detectedX = override.x;
      tile.detectedY = override.y;
      tile.accepted = true;
      tile.manualOverride = true;
    }
  }
}

/**
 * Preserve the original auto-detected marker positions so manual edits can be reverted cleanly.
 *
 * @param {object | null} alignmentInfo
 * @returns {void}
 */
function stashOriginalMarkerDetections(alignmentInfo) {
  if (!alignmentInfo) return;
  for (const marker of alignmentInfo.markerLookup.values()) {
    if (!Number.isFinite(marker.autoDetectedX)) {
      marker.autoDetectedX = marker.detectedX;
      marker.autoDetectedY = marker.detectedY;
    }
  }
  for (const tile of alignmentInfo.crossRoiTiles || []) {
    if (!Number.isFinite(tile.autoDetectedX)) {
      tile.autoDetectedX = tile.detectedX;
      tile.autoDetectedY = tile.detectedY;
    }
  }
}

/**
 * Make the sidebar's collapsible control groups behave like an accordion.
 *
 * Opening one collapsible panel closes the others, while non-collapsible sections
 * like Photo and Status remain unaffected.
 *
 * @returns {void}
 */
function initAccordionPanels() {
  const panels = [...document.querySelectorAll(".control-panel details.collapsible")];
  panels.forEach((panel) => {
    panel.addEventListener("toggle", () => {
      if (!panel.open) return;
      panels.forEach((other) => {
        if (other !== panel) other.open = false;
      });
    });
  });
}

/**
 * Close all collapsible sidebar panels.
 *
 * This is used when loading a new image so the user returns to the compact default layout.
 *
 * @returns {void}
 */
function collapseAllPanels() {
  const panels = document.querySelectorAll(".control-panel details.collapsible");
  panels.forEach((panel) => {
    panel.open = false;
  });
}

/**
 * Restore all appearance controls to their defaults and invalidate derived caches.
 *
 * @returns {void}
 */
function resetAppearanceControls() {
  applyAppearanceDefaults(dom);
  revokeGifUrl();
  updateSliderReadouts();
  invalidateAppearanceCache();
  refreshAppearanceOutputs();
  drawCurrentGifPreview();
  scheduleCurrentPreviewFrameWarmup();
}

/**
 * Restore all trim controls to zero and rerun geometry extraction.
 *
 * @returns {void}
 */
function resetTrimControls() {
  const alreadyReset =
    (Number(dom.cropLeft.value) || 0) === 0 &&
    (Number(dom.cropRight.value) || 0) === 0 &&
    (Number(dom.cropTop.value) || 0) === 0 &&
    (Number(dom.cropBottom.value) || 0) === 0 &&
    !dom.flipHorizontal.checked &&
    !dom.flipVertical.checked &&
    !dom.rotate90Cw.checked;
  if (alreadyReset) {
    return;
  }
  applyCropGeometryDefaults(dom);
  revokeGifUrl();
  updateSliderReadouts();
  invalidateFrameOutputCaches();
  drawCurrentGifPreview();
}

/**
 * Restore Export Options controls to their defaults and return output size to native 100%.
 *
 * @returns {void}
 */
function resetExportControls() {
  const previousOutputSize = getRequestedOutputSize();
  const maxFrameCount = getFrameExportCountMax();
  const alreadyReset =
    (Number(dom.fps.value) || SETTINGS_DEFAULTS.gifExport.fps) === SETTINGS_DEFAULTS.gifExport.fps &&
    (Number(dom.loopCount.value) || SETTINGS_DEFAULTS.gifExport.loopCount) === SETTINGS_DEFAULTS.gifExport.loopCount &&
    (Number(dom.frameCountToExport?.value) || maxFrameCount) === maxFrameCount &&
    !dom.reverseOrder.checked &&
    !dom.boustrophedonOrder.checked &&
    !dom.pingPong.checked &&
    getEncodingQualityValue() === SETTINGS_DEFAULTS.gifExport.quality &&
    (dom.gifDither.value || SETTINGS_DEFAULTS.gifExport.dither) === SETTINGS_DEFAULTS.gifExport.dither &&
    !dom.gifGlobalPalette.checked &&
    state.runtime.outputSizeAuto;
  if (alreadyReset) {
    return;
  }
  dom.fps.value = String(SETTINGS_DEFAULTS.gifExport.fps);
  dom.loopCount.value = String(SETTINGS_DEFAULTS.gifExport.loopCount);
  if (dom.frameCountToExport) {
    dom.frameCountToExport.value = String(maxFrameCount);
  }
  dom.reverseOrder.checked = SETTINGS_DEFAULTS.gifExport.reverseOrder;
  dom.boustrophedonOrder.checked = SETTINGS_DEFAULTS.gifExport.boustrophedonOrder;
  dom.pingPong.checked = SETTINGS_DEFAULTS.gifExport.pingPong;
  dom.outputWidth.value = "";
  dom.outputHeight.value = "";
  dom.gifQuality.value = String(SETTINGS_DEFAULTS.gifExport.quality);
  dom.gifDither.value = SETTINGS_DEFAULTS.gifExport.dither;
  dom.gifGlobalPalette.checked = SETTINGS_DEFAULTS.gifExport.globalPalette;
  state.runtime.outputWidthPx = 0;
  state.runtime.outputHeightPx = 0;
  state.runtime.outputSizeAuto = true;
  state.runtime.outputSizeAnchor = "auto";
  state.runtime.pendingOutputScale = null;
  revokeGifUrl();
  updateSliderReadouts();
  const nextOutputSize = getRequestedOutputSize();
  if (
    previousOutputSize.width !== nextOutputSize.width ||
    previousOutputSize.height !== nextOutputSize.height
  ) {
    invalidateFrameOutputCaches();
    scheduleCurrentPreviewFrameWarmup();
  }
  drawCurrentGifPreview();
}

/**
 * Restore every non-Layout control to its default value.
 *
 * Layout settings are intentionally preserved across image loads, while detection,
 * appearance, crop/geometry, and GIF export controls all return to their startup defaults.
 *
 * @returns {void}
 */
function resetNonLayoutControls() {
  applyNonLayoutDefaults(dom);
  // `applyNonLayoutDefaults` restores the pipeline radio to the default ("markers"); clear the
  // legacy per-frame force shim too so `isPerFrameModeActive()` agrees with the reset radio.
  state.runtime.forcePerFrameMode = false;
  state.geometry.manualMarkerOverrides.clear();
  state.preview.activeEditedMarker = null;
  state.runtime.markerEditingEnabled = false;
  state.runtime.outputWidthPx = 0;
  state.runtime.outputHeightPx = 0;
  state.runtime.outputSizeAuto = true;
  state.runtime.outputSizeAnchor = "auto";
  state.runtime.pendingOutputScale = null;

  state.preview.paused = false;
  updatePreviewPlayPauseButton();
  syncAlignmentMarkerUi();
  syncMarkerEditingUi();
  updateSliderReadouts();
}

/**
 * Mark OpenCV ready and initialize any controls that depend on its runtime capabilities.
 *
 * @returns {void}
 */
function onOpenCvReady() {
  state.runtime.cvReady = true;
  populateResamplingOptions();
  setStatus(t("status.openCvReady"));
}

/**
 * Invalidate any queued or active processing pass by bumping the request id.
 *
 * @returns {void}
 */
function cancelInFlightProcessing() {
  state.processing.requestId += 1;
  state.processing.pending = false;
  window.clearTimeout(state.processing.timer);
  cancelStabilizationMeasurement();
  cancelPreviewFrameWarmup();
  setGeometryProcessingCursor(false);
}

/**
 * Coalesce rapid appearance updates into one animation-frame preview refresh.
 *
 * @param {boolean} [includeRectified=false]
 * @returns {void}
 */
function scheduleAppearancePreviewUpdate(includeRectified = false) {
  state.preview.appearancePreviewNeedsRectified = state.preview.appearancePreviewNeedsRectified || includeRectified;
  if (state.preview.appearancePreviewRaf) return;
  state.preview.appearancePreviewRaf = requestAnimationFrame(() => {
    state.preview.appearancePreviewRaf = 0;
    if (state.preview.appearancePreviewNeedsRectified) {
      refreshAppearanceOutputs();
    }
    state.preview.appearancePreviewNeedsRectified = false;
    drawCurrentGifPreview();
    scheduleCurrentPreviewFrameWarmup();
  });
}

/**
 * Coalesce markerless phase-slider preview updates into one animation-frame redraw.
 *
 * @returns {void}
 */
function scheduleMarkerlessPhasePreviewUpdate() {
  if (state.preview.markerlessPhasePreviewRaf) return;
  state.preview.markerlessPhasePreviewRaf = requestAnimationFrame(() => {
    state.preview.markerlessPhasePreviewRaf = 0;
    runTimedHeavyPath("Heavy path: markerless-phase-preview", () => {
      renderCrossRoiGrid(state.geometry.alignmentInfo);
      drawCurrentGifPreview();
    });
  });
}

/**
 * Coalesce post-rotation scrub preview updates into one animation-frame redraw.
 *
 * This is intentionally preview-only work: it redraws Rectified Grid and Panel 3 from the
 * current preview-scale buffers without rerunning the full OpenCV pipeline on every slider tick.
 *
 * @returns {void}
 */
function schedulePostRotationPreviewUpdate() {
  if (state.preview.postRotationPreviewRaf) return;
  state.preview.postRotationPreviewRaf = requestAnimationFrame(() => {
    state.preview.postRotationPreviewRaf = 0;
    runTimedHeavyPath("Heavy path: post-rotation-preview", () => {
      renderCrossRoiGrid(state.geometry.alignmentInfo);
      drawCurrentGifPreview();
    });
  });
}

/**
 * Coalesce stabilization preview updates into one animation-frame redraw.
 *
 * @returns {void}
 */
function scheduleStabilizationPreviewUpdate() {
  if (state.preview.stabilizationPreviewRaf) return;
  state.preview.stabilizationPreviewRaf = requestAnimationFrame(() => {
    state.preview.stabilizationPreviewRaf = 0;
    runTimedHeavyPath("Heavy path: stabilization-preview", () => {
      if (!state.preview.markerOverrideScrubbing) {
        renderCrossRoiGrid(state.geometry.alignmentInfo);
      }
      drawCurrentGifPreview();
    });
  });
}

/**
 * Pause Preview playback while the stabilization rigidity slider is actively scrubbed.
 *
 * @returns {void}
 */
function beginStabilizationStrengthScrub() {
  // Stabilization is available in markerless and per-frame; warm the solver for both non-marker modes.
  if (readConfig().alignmentPipeline !== "markers") {
    scheduleCurrentStabilizationWarmup();
  }
  if (state.preview.stabilizationStrengthScrubbing) return;
  state.preview.stabilizationStrengthScrubbing = true;
  if (state.preview.paused) {
    state.preview.stabilizationStrengthResumePlayback = false;
    return;
  }
  state.preview.stabilizationStrengthResumePlayback = true;
  state.preview.paused = true;
  updatePreviewPlayPauseButton();
}

/**
 * Restore Preview playback after stabilization-rigidity scrubbing if the scrub initiated the pause.
 *
 * @returns {void}
 */
function endStabilizationStrengthScrub() {
  if (!state.preview.stabilizationStrengthScrubbing) return;
  state.preview.stabilizationStrengthScrubbing = false;
  if (!state.preview.stabilizationStrengthResumePlayback) return;
  state.preview.stabilizationStrengthResumePlayback = false;
  state.preview.paused = false;
  updatePreviewPlayPauseButton();
}

/**
 * Pause Preview playback while a markerless corner override is actively scrubbed.
 *
 * @returns {void}
 */
function beginMarkerOverrideScrub() {
  if (state.preview.markerOverrideScrubbing) return;
  state.preview.markerOverrideScrubbing = true;
  if (state.preview.paused) {
    state.preview.markerOverrideResumePlayback = false;
    return;
  }
  state.preview.markerOverrideResumePlayback = true;
  state.preview.paused = true;
  updatePreviewPlayPauseButton();
}

/**
 * Restore Preview playback after a markerless corner override scrub if the scrub initiated pause.
 *
 * @returns {void}
 */
function endMarkerOverrideScrub() {
  if (!state.preview.markerOverrideScrubbing) return;
  state.preview.markerOverrideScrubbing = false;
  if (!state.preview.markerOverrideResumePlayback) return;
  state.preview.markerOverrideResumePlayback = false;
  state.preview.paused = false;
  updatePreviewPlayPauseButton();
}

/**
 * Pause Preview playback while a markerless phase slider is actively scrubbed.
 *
 * @returns {void}
 */
function beginMarkerlessPhaseScrub() {
  if (state.preview.markerlessPhaseScrubbing) return;
  state.preview.markerlessPhaseScrubbing = true;
  if (state.preview.paused) {
    state.preview.markerlessPhaseResumePlayback = false;
    return;
  }
  state.preview.markerlessPhaseResumePlayback = true;
  state.preview.paused = true;
  updatePreviewPlayPauseButton();
}

/**
 * Restore Preview playback after a markerless phase scrub if the scrub initiated the pause.
 *
 * @returns {void}
 */
function endMarkerlessPhaseScrub() {
  if (!state.preview.markerlessPhaseScrubbing) return;
  state.preview.markerlessPhaseScrubbing = false;
  if (!state.preview.markerlessPhaseResumePlayback) return;
  state.preview.markerlessPhaseResumePlayback = false;
  state.preview.paused = false;
  updatePreviewPlayPauseButton();
}

/**
 * Pause Preview playback while the post-rotation slider is actively scrubbed.
 *
 * @returns {void}
 */
function beginPostRotationScrub() {
  if (state.preview.postRotationScrubbing) return;
  state.preview.postRotationScrubbing = true;
  if (state.preview.paused) {
    state.preview.postRotationResumePlayback = false;
    return;
  }
  state.preview.postRotationResumePlayback = true;
  state.preview.paused = true;
  updatePreviewPlayPauseButton();
}

/**
 * Restore Preview playback after a post-rotation scrub if the scrub initiated the pause.
 *
 * @returns {void}
 */
function endPostRotationScrub() {
  if (!state.preview.postRotationScrubbing) return;
  state.preview.postRotationScrubbing = false;
  state.preview.postRotationPreviewCanvas = null;
  state.preview.postRotationPreviewSourceCanvas = null;
  state.preview.postRotationPreviewDeg = 0;
  if (!state.preview.postRotationResumePlayback) return;
  state.preview.postRotationResumePlayback = false;
  state.preview.paused = false;
  updatePreviewPlayPauseButton();
}

/**
 * End Post-Rotation scrub mode immediately when the slider returns to the already-processed value.
 *
 * In that case there is no net geometry change to process, so keeping the low-resolution scrub
 * preview alive only leaves playback paused and Panel 3 blurry for no reason.
 *
 * @returns {boolean}
 */
function finishPostRotationScrubIfUnchanged() {
  if (!state.preview.postRotationScrubbing) return false;
  if (Math.abs(getPostRotationPreviewDeg()) > 1e-9) return false;
  endPostRotationScrub();
  if (state.geometry.alignmentInfo) {
    renderCrossRoiGrid(state.geometry.alignmentInfo);
  }
  drawCurrentGifPreview();
  return true;
}

/**
 * Read the Post-Rotation slider value, clamped to the slider's range.
 *
 * @returns {number}
 */
function readPostRotationSliderDeg() {
  return Math.max(
    -1.1,
    Math.min(
      1.1,
      Number.isFinite(Number(dom.postRotation?.value))
        ? Number(dom.postRotation.value)
        : SETTINGS_DEFAULTS.detection.postRotationDeg
    )
  );
}

/**
 * Persist the current Post-Rotation slider value onto the active per-frame image entry.
 *
 * In per-frame mode each image carries its own Post-Rotation; the global slider edits the active
 * image's value so reprocessing rectifies that image with its own rotation. In markers / markerless
 * mode this is a no-op (Post-Rotation stays a single global value read from `config.postRotationDeg`),
 * so legacy behavior is unchanged.
 *
 * @returns {void}
 */
function commitActivePostRotationFromSlider() {
  if (!isPerFrameModeActive()) return;
  setActivePostRotationDeg(state, readPostRotationSliderDeg(), true);
}

/**
 * Populate the resampling dropdown with only the interpolation modes available in this OpenCV build.
 *
 * @returns {void}
 */
function populateResamplingOptions() {
  const select = dom.gifResampling;
  const previousValue = select.value || "linear";
  select.innerHTML = "";
  const options = [
    { value: "area", label: t("export.dynamicResamplingOptions.area") },
    { value: "linear", label: t("export.dynamicResamplingOptions.linear") },
    { value: "cubic", label: t("export.dynamicResamplingOptions.cubic") },
  ];
  if (typeof cv !== "undefined" && typeof cv.INTER_LANCZOS4 !== "undefined") {
    options.push({ value: "lanczos", label: t("export.dynamicResamplingOptions.lanczos") });
  }
  if (typeof cv !== "undefined" && typeof cv.INTER_NEAREST !== "undefined") {
    options.push({ value: "nearest", label: t("export.dynamicResamplingOptions.nearest") });
  }
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    if (option.value === previousValue) el.selected = true;
    select.appendChild(el);
  }
}

/**
 * Rerender previews after window resize settles so canvases match their new boxes.
 *
 * @returns {void}
 */
function attachResizeHandler() {
  window.addEventListener("resize", () => {
    window.clearTimeout(state.preview.resizeTimer);
    state.preview.resizeTimer = window.setTimeout(() => {
      syncResponsiveViewerUi();
      window.requestAnimationFrame(() => {
        syncRawPhotoHeadingLink();
        rerenderPreviews();
      });
    }, 40);
  });
}

/**
 * Keep the Page Corners title link synchronized with the currently loaded source image.
 *
 * @returns {void}
 */
function syncRawPhotoHeadingLink() {
  if (!dom.rawPhotoHeadingText) return;
  const translatedTitle = String(t("panels.rawPhoto") || "").trim();
  dom.rawPhotoHeadingText.textContent = translatedTitle.replace(/^\s*\d+\s*[\.\):\-–—]?\s*/, "") || "Page Corners";
  const href = state.source.dragUrl ? new URL(state.source.dragUrl, window.location.href).href : "";
  if (href) {
    dom.rawPhotoHeadingText.href = href;
  } else {
    dom.rawPhotoHeadingText.removeAttribute("href");
  }
  dom.rawPhotoHeadingText.title = state.runtime.tooltipsEnabled ? t("tooltip.rawPhotoName") : "";
}

/**
 * Keep the Rectified Grid title link synchronized with the currently available full-resolution
 * download strategy.
 *
 * Small rectified sheets can keep a prebuilt object URL on hand. Large ones are generated lazily
 * on click from the authoritative OpenCV mat so the preview canvas can stay downscaled. In the
 * markerless near-identity fast path, this link can point straight at the raw source asset instead.
 *
 * @returns {void}
 */
function syncRectifiedSheetHeadingLink() {
  if (!dom.rectifiedSheetHeadingText) return;
  const translatedTitle = String(
    state.preview.showRectifiedDiagnostic ? t("panels.convolutionDebugView") : t("panels.rectifiedSheet")
  ).trim();
  const headingText = translatedTitle.replace(/^\s*\d+\s*[\.\):\-–—]?\s*/, "") || "Rectified Grid";
  if (dom.rectifiedSheetHeadingText.textContent !== headingText) {
    dom.rectifiedSheetHeadingText.textContent = headingText;
  }
  const titleText = state.runtime.tooltipsEnabled ? t("tooltip.rectifiedSheetHeading") : "";
  if (dom.rectifiedSheetHeadingText.title !== titleText) {
    dom.rectifiedSheetHeadingText.title = titleText;
  }
  if (state.preview.showRectifiedDiagnostic) {
    if (dom.rectifiedSheetHeadingText.hasAttribute("href")) {
      dom.rectifiedSheetHeadingText.removeAttribute("href");
    }
    if (dom.rectifiedSheetHeadingText.hasAttribute("download")) {
      dom.rectifiedSheetHeadingText.removeAttribute("download");
    }
    return;
  }
  if (state.geometry.rectifiedDownloadUsesRawSource && state.source.dragUrl) {
    const href = new URL(state.source.dragUrl, window.location.href).href;
    const download = makeRectifiedFilename(state.source.filename);
    if (dom.rectifiedSheetHeadingText.href !== href) {
      dom.rectifiedSheetHeadingText.href = href;
    }
    if (dom.rectifiedSheetHeadingText.download !== download) {
      dom.rectifiedSheetHeadingText.download = download;
    }
    return;
  }
  if (state.preview.rectifiedFullResUrl) {
    const href = state.preview.rectifiedFullResUrl;
    const download = makeRectifiedFilename(state.source.filename);
    if (dom.rectifiedSheetHeadingText.href !== href) {
      dom.rectifiedSheetHeadingText.href = href;
    }
    if (dom.rectifiedSheetHeadingText.download !== download) {
      dom.rectifiedSheetHeadingText.download = download;
    }
    return;
  }
  const hasRectifiedSource =
    !!state.geometry.baseRectifiedMat ||
    !!state.geometry.baseRectifiedCanvas ||
    !!state.preview.rectifiedCanvas;
  if (hasRectifiedSource) {
    const href = new URL("#", window.location.href).href;
    if (dom.rectifiedSheetHeadingText.href !== href) {
      dom.rectifiedSheetHeadingText.href = "#";
    }
  } else {
    if (dom.rectifiedSheetHeadingText.hasAttribute("href")) {
      dom.rectifiedSheetHeadingText.removeAttribute("href");
    }
  }
  if (dom.rectifiedSheetHeadingText.hasAttribute("download")) {
    dom.rectifiedSheetHeadingText.removeAttribute("download");
  }
}

/**
 * Encode the authoritative full-resolution rectified mat into a blob URL.
 *
 * The visible Rectified Grid panel may be downscaled for large sources, so download generation
 * must come from the OpenCV mat instead of the preview canvas.
 *
 * @param {cv.Mat} rectifiedMat
 * @param {(url:string | null) => void} onReady
 * @returns {void}
 */
function encodeRectifiedMatToBlobUrl(rectifiedMat, onReady) {
  const rgba = new cv.Mat();
  const exportCanvas = document.createElement("canvas");
  try {
    if (rectifiedMat.type() === cv.CV_8UC4) {
      rectifiedMat.copyTo(rgba);
    } else if (rectifiedMat.type() === cv.CV_8UC3) {
      cv.cvtColor(rectifiedMat, rgba, cv.COLOR_BGR2RGBA);
    } else if (rectifiedMat.type() === cv.CV_8UC1) {
      cv.cvtColor(rectifiedMat, rgba, cv.COLOR_GRAY2RGBA);
    } else {
      throw new Error(`Unsupported rectified Mat type: ${rectifiedMat.type()}`);
    }
    exportCanvas.width = rgba.cols;
    exportCanvas.height = rgba.rows;
    const ctx = exportCanvas.getContext("2d");
    const imageData = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
    ctx.putImageData(imageData, 0, 0);
    exportCanvas.toBlob((blob) => {
      exportCanvas.width = 0;
      exportCanvas.height = 0;
      if (!blob) {
        onReady(null);
        return;
      }
      onReady(URL.createObjectURL(blob));
    });
  } finally {
    rgba.delete();
  }
}

/**
 * Prebuild the full-resolution rectified-sheet asset only when the rectified sheet is modest.
 *
 * Large rectified sheets are generated lazily on click so the UI does not keep an extra full-size
 * RGBA canvas/blob resident alongside the OpenCV mat.
 *
 * @returns {void}
 */
function primeRectifiedFullResAssetIfSmall() {
  releaseRectifiedFullResUrl();
  state.preview.rectifiedFullResBuildId += 1;
  const buildId = state.preview.rectifiedFullResBuildId;
  if (state.geometry.rectifiedDownloadUsesRawSource) {
    syncRectifiedSheetHeadingLink();
    return;
  }
  const rectifiedMat = state.geometry.baseRectifiedMat;
  if (!rectifiedMat) {
    syncRectifiedSheetHeadingLink();
    return;
  }
  const longEdge = Math.max(rectifiedMat.cols || 0, rectifiedMat.rows || 0);
  if (longEdge > RECTIFIED_FULL_RES_EAGER_LONG_EDGE_PX) {
    syncRectifiedSheetHeadingLink();
    return;
  }
  encodeRectifiedMatToBlobUrl(rectifiedMat, (url) => {
    if (!url) return;
    if (buildId !== state.preview.rectifiedFullResBuildId) {
      URL.revokeObjectURL(url);
      return;
    }
    state.preview.rectifiedFullResUrl = url;
    syncRectifiedSheetHeadingLink();
  });
}

/**
 * Generate and download the full-resolution rectified sheet on demand.
 *
 * @returns {void}
 */
function downloadFullResRectifiedSheet() {
  if (!state.source.image || state.processing.active) return;
  if (state.geometry.rectifiedDownloadUsesRawSource && state.source.dragUrl) {
    const anchor = document.createElement("a");
    anchor.href = new URL(state.source.dragUrl, window.location.href).href;
    anchor.download = makeRectifiedFilename(state.source.filename);
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.click();
    return;
  }
  const rectifiedMat = ensureBaseRectifiedMat();
  if (!rectifiedMat) return;
  setGeometryProcessingCursor(true);
  window.requestAnimationFrame(() => {
    try {
      encodeRectifiedMatToBlobUrl(rectifiedMat, (url) => {
        try {
          if (!url) return;
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = makeRectifiedFilename(state.source.filename);
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } finally {
          setGeometryProcessingCursor(false);
        }
      });
    } catch (error) {
      console.error(error);
      setGeometryProcessingCursor(false);
    }
  });
}

/**
 * Show the optional source-credit line associated with the Page Corners panel.
 *
 * Prefer explicit `source_credit` metadata from the settings file. If none is present, fall back
 * to the loaded source filename using the same inline small-text treatment.
 *
 * @returns {void}
 */
function syncRawPhotoCreditDisplay() {
  if (!dom.rawPhotoCredit) return;
  const credit = String(state.source.sourceCredit || "").trim();
  const fallbackFilename = String(state.source.filename || "").trim();
  const displayText = credit || fallbackFilename;
  dom.rawPhotoCredit.textContent = displayText;
  // Disabled while Page Corners header actions need the horizontal space. Keep the text synchronized
  // so the header credit line can be restored later without rebuilding the metadata path.
  dom.rawPhotoCredit.hidden = true;
}

/**
 * Load an image selected by the user from a File object.
 *
 * @param {File} file
 * @returns {Promise<void>}
 */
async function handleFile(file, files = null) {
  await loadFileSource(file, files, { state, loadImageSource, applySettingsFile });
}

/**
 * Load an image from a URL, reset dependent state, and kick off processing.
 *
 * @param {string} src
 * @param {string} [filename=""]
 * @param {string} [mimeType="image/jpeg"]
 * @param {File | null} [settingsFile=null]
 * @param {File[]} [additionalImageFiles=[]] Extra images beyond the primary, loaded as per-frame entries.
 * @param {{
 *   companionSettingsText?: string | null,
 *   additionalImageSources?: { src: string, filename?: string, mimeType?: string }[],
 *   demoId?: string,
 * }} [options={}]
 * @returns {Promise<void>}
 */
async function loadImageSource(
  src,
  filename = "",
  mimeType = "image/jpeg",
  settingsFile = null,
  additionalImageFiles = [],
  options = {},
) {
  clearDemoQueryIfLoadingDifferentFile(filename, options.demoId || "");
  await loadImageSourceViaController({
    src,
    filename,
    mimeType,
    settingsFile,
    additionalImageFiles,
    additionalImageSources: options.additionalImageSources || [],
    companionSettingsText: options.companionSettingsText ?? null,
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
    // After a per-frame settings restore reattaches buffered per-image overrides, refresh the active
    // entry's legacy field + Post-Rotation slider + Page Corners overlay + strip so the editor reflects
    // the restored values (no-op for single-image markers/markerless loads).
    refreshActiveImage: setActiveImage,
  });
}

/**
 * Debounce a geometry-affecting reprocess so multiple control edits collapse into one run.
 *
 * The busy cursor is enabled immediately so synchronous-looking pauses still read as "working"
 * rather than "frozen" while the debounce timer is counting down.
 *
 * @param {number} [delayMs=220]
 * @returns {void}
 */
function scheduleProcess(delayMs = 220) {
  if (!state.source.image) return;
  state.processing.requestId += 1;
  const requestId = state.processing.requestId;
  window.clearTimeout(state.processing.timer);
  setGeometryProcessingCursor(true);
  state.processing.timer = window.setTimeout(() => {
    void processCurrentImage(requestId);
  }, Math.max(0, delayMs));
}

/**
 * Decode and append additional images as per-frame entries, then reprocess with the new frame count.
 *
 * Reuses the Phase 4 decode path (`decodeImageElement`) so the strip's `+` tile and additional drops
 * share one code path. Each new entry owns its own blob URL + source-resolution canvas. If the strip
 * was empty (e.g. after deleting every image), the first added entry becomes the active image and the
 * legacy projections are repointed at it via `setActiveImage`. Forces per-frame mode on so adding
 * images never silently changes pipelines.
 *
 * @param {File[]} files
 * @returns {Promise<void>}
 */
async function addPerFrameImages(files) {
  const imageFiles = (files || []).filter((file) => file && String(file.type || "").startsWith("image/"));
  if (imageFiles.length === 0) return;

  setGeometryProcessingCursor(true);
  const startedEmpty = !Array.isArray(state.source.images) || state.source.images.length === 0;
  if (!Array.isArray(state.source.images)) state.source.images = [];

  let addedAny = false;
  for (const file of imageFiles) {
    const url = URL.createObjectURL(file);
    let image;
    try {
      image = await decodeImageElement(url);
    } catch {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already revoked */
      }
      continue;
    }
    const canvas = document.createElement("canvas");
    drawImageToCanvas(image, canvas);
    state.source.images.push(
      createSourceImageEntry({
        image,
        filename: file.name || "",
        mimeType: file.type || "image/jpeg",
        ownedObjectUrl: url,
        dragUrl: url,
        canvas,
      }),
    );
    addedAny = true;
  }
  if (!addedAny) {
    setGeometryProcessingCursor(false);
    return;
  }

  // Adding images is an explicit per-frame action; make sure the pipeline is in per-frame mode.
  state.runtime.forcePerFrameMode = true;
  if (dom.alignmentPipelinePerFrame) dom.alignmentPipelinePerFrame.checked = true;
  document.body.classList.add("has-loaded-image");

  // If a per-frame settings file was loaded before any images (the reload story), reattach its
  // buffered per-image overrides by upload order to the now-present images, then consume the buffer.
  applyPendingPerImageOverrides(state);

  if (startedEmpty) {
    // No active image existed (fresh or fully-emptied strip): adopt the first new entry as active and
    // repoint the legacy projections so processCurrentImage has a source image to read.
    setActiveImage(0);
  }
  syncAlignmentMarkerUi();
  renderPerFrameStrip();
  updateSliderReadouts();
  scheduleProcess(0);
}

/**
 * Report whether the per-frame alignment pipeline is currently active.
 *
 * Per-frame mode is selected by its own radio (added in Phase 6) or, until then, by a dev/multi-file
 * flag (`state.runtime.forcePerFrameMode`). The radio ref is read with optional chaining so this is
 * forward-compatible with Phase 6 wiring `dom.alignmentPipelinePerFrame`. This matches the detection
 * `readConfig` uses, so per-image override routing and the active config stay consistent.
 *
 * @returns {boolean}
 */
function isPerFrameModeActive() {
  return !!dom.alignmentPipelinePerFrame?.checked || !!state.runtime.forcePerFrameMode;
}

/**
 * Upper bound for the `Frames in Export` control and the export-options clamp.
 *
 * Grid pipelines cap at Frame Columns × Frame Rows. Per-frame mode caps at the number of uploaded
 * images (or extracted frames once processing has run).
 *
 * @returns {number}
 */
function getFrameExportCountMax() {
  if (isPerFrameModeActive()) {
    const imageCount = Array.isArray(state.source.images) ? state.source.images.length : 0;
    const frameBudget = imageCount > 0 ? imageCount : Math.max(0, state.geometry.frameCount || 0);
    return Math.max(1, frameBudget);
  }
  const cols = Math.max(1, Math.min(20, Math.round(Number(dom.frameCols.value) || SETTINGS_DEFAULTS.layout.frameCols)));
  const rows = Math.max(1, Math.min(20, Math.round(Number(dom.frameRows.value) || SETTINGS_DEFAULTS.layout.frameRows)));
  return Math.max(1, cols * rows);
}

/**
 * Read the current UI state and normalize it into a processing/export config object.
 *
 * @returns {{
 *   paperPreset:string,
 *   paperWidthIn:number,
 *   paperHeightIn:number,
 *   paperAspect:number,
 *   frameCols:number,
 *   frameRows:number,
 *   manualPageQuadPoints:{x:number,y:number}[] | null,
 *   fallbackPageQuadPoints:{x:number,y:number}[] | null,
 *   thresholdMethod:string,
 *   thresholdOffset:number,
 *   paperMarginXPx:number,
 *   paperMarginYPx:number,
 *   boundarySensitivity:number,
 *   boundaryPersistencePx:number,
 *   postRotationDeg:number,
 *   alignmentPipeline:string,
 *   stabilizationMethod:string,
 *   stabilizationEnabled:boolean,
 *   stabilizationStrengthPct:number,
 *   alignmentMarkerType:string,
 *   crossRoiScalePct:number,
 *   crossRoiScale:number,
 *   stabilizationLambda:number,
 *   markerlessPhaseX:number,
 *   markerlessPhaseY:number,
 *   verticalDriftCompensation:number,
 *   markerlessUseDarkness:boolean,
 *   markerlessUseTexture:boolean,
 *   markerlessUseVariance:boolean,
 *   lightOnDarkDesign:boolean,
 *   detectCrossesWithConvolution:boolean,
 *   useCrossAlignment:boolean,
 *   crop:{left:number,right:number,top:number,bottom:number},
 *   postCropGeometry:{flipHorizontal:boolean,flipVertical:boolean,rotate90Cw:boolean},
 *   filters:{brightness:number,contrast:number,vibrance:number,temperature:number,unsharpRadius:number,unsharpAmount:number,invert:boolean},
 *   fps:number,
 *   exportOptions:{encodingQuality:number,quality:number,mp4Quality:number,dither:string|false,resampling:string,globalPalette:boolean,outputWidthPx:number,outputHeightPx:number,outputScale:number,reverseOrder:boolean,boustrophedonOrder:boolean,pingPong:boolean,loopCount:number,frameCountToExport:number}
 * }}
 */
function readConfig() {
  const paperPreset = dom.paperPreset.value || SETTINGS_DEFAULTS.layout.paperPreset;
  const presetSize = getPaperPresetSize(paperPreset);
  const isCustomPaper = paperPreset === "custom";
  const isSourcePaper = paperPreset === "source";
  const paperOrientation = dom.paperOrientationPortrait.checked ? "portrait" : "landscape";
  const orientedPresetWidth = isSourcePaper
    ? (presetSize?.width || SETTINGS_DEFAULTS.layout.paperWidth)
    : (paperOrientation === "portrait")
    ? (presetSize?.height || SETTINGS_DEFAULTS.layout.paperHeight)
    : (presetSize?.width || SETTINGS_DEFAULTS.layout.paperWidth);
  const orientedPresetHeight = isSourcePaper
    ? (presetSize?.height || SETTINGS_DEFAULTS.layout.paperHeight)
    : (paperOrientation === "portrait")
    ? (presetSize?.width || SETTINGS_DEFAULTS.layout.paperWidth)
    : (presetSize?.height || SETTINGS_DEFAULTS.layout.paperHeight);
  const paperWidth = isCustomPaper
    ? (Number(dom.paperWidth.value) || SETTINGS_DEFAULTS.layout.paperWidth)
    : orientedPresetWidth;
  const paperHeight = isCustomPaper
    ? (Number(dom.paperHeight.value) || SETTINGS_DEFAULTS.layout.paperHeight)
    : orientedPresetHeight;
  const paperAspect = clampPaperAspect(paperWidth, paperHeight);
  const frameCols = Math.max(1, Math.min(20, Math.round(Number(dom.frameCols.value) || SETTINGS_DEFAULTS.layout.frameCols)));
  const frameRows = Math.max(1, Math.min(20, Math.round(Number(dom.frameRows.value) || SETTINGS_DEFAULTS.layout.frameRows)));
  const sourceFrameCount = getFrameExportCountMax();
  // Per-frame mode is selected by its own radio (added in Phase 6) or, until then, by a dev flag so
  // the pipeline can be exercised before the UI exists. See isPerFrameModeActive for details.
  const perFrameModeActive = isPerFrameModeActive();
  const encodingQuality = getEncodingQualityValue();
  const readSearchInset = (input, fallback) => Math.max(
    0,
    Math.min(
      256,
      Math.round(
        Number.isFinite(Number(input?.value))
          ? Number(input.value)
          : fallback
      )
    )
  );
  const config = {
    paperOrientation,
    paperPreset,
    paperWidthIn: Math.max(1, paperWidth),
    paperHeightIn: Math.max(1, paperHeight),
    paperAspect,
    frameCols,
    frameRows,
    manualPageQuadPoints: null,
    fallbackPageQuadPoints: null,
    thresholdMethod: dom.thresholdMethod.value || SETTINGS_DEFAULTS.detection.thresholdMethod,
    thresholdOffset: Math.max(-128, Math.min(128, Math.round(Number(dom.thresholdOffset.value) || SETTINGS_DEFAULTS.detection.thresholdOffset))),
    paperMarginXPx: readSearchInset(dom.paperMarginX, SETTINGS_DEFAULTS.detection.paperMarginXPx),
    paperMarginYPx: readSearchInset(dom.paperMarginY, SETTINGS_DEFAULTS.detection.paperMarginYPx),
    boundarySensitivity: Math.max(0, Math.min(20, Number(dom.boundarySensitivity.value) || SETTINGS_DEFAULTS.detection.boundarySensitivity)),
    boundaryPersistencePx: Math.max(1, Math.min(15, Math.round(Number(dom.boundaryPersistence.value) || SETTINGS_DEFAULTS.detection.boundaryPersistencePx))),
    postRotationDeg: Math.max(
      -1.1,
      Math.min(
        1.1,
        Number.isFinite(Number(dom.postRotation?.value))
          ? Number(dom.postRotation.value)
          : SETTINGS_DEFAULTS.detection.postRotationDeg
      )
    ),
    alignmentPipeline: perFrameModeActive
      ? "per-frame"
      : dom.alignmentPipelineMarkerless.checked
      ? "markerless"
      : "markers",
    // The radio group exposes a temporary-friendly UI label, but the config keeps stable internal
    // ids so settings files and solver branching do not depend on user-facing wording.
    stabilizationMethod: dom.stabilizationMethodAverage?.checked ? "difference-from-average" : "pairwise-cyclic",
    stabilizationEnabled: !!dom.stabilizationEnabled?.checked,
    stabilizationStrengthPct: Math.max(
      0,
      Math.min(
        125,
        Number.isFinite(Number(dom.stabilizationStrength?.value))
          ? Math.round(Number(dom.stabilizationStrength.value))
          : SETTINGS_DEFAULTS.detection.stabilizationStrengthPct
      )
    ),
    alignmentMarkerType: dom.alignmentMarkerType.value || "crosses",
    crossRoiScalePct: Math.max(18, Math.min(110, Number(dom.crossRoiScale.value) || SETTINGS_DEFAULTS.detection.crossRoiScalePct)),
    crossRoiScale: Math.max(0.18, Math.min(1.1, (Number(dom.crossRoiScale.value) || SETTINGS_DEFAULTS.detection.crossRoiScalePct) / 100)),
    stabilizationLambda: Math.max(0.001, Math.min(0.1, Number(dom.stabilizationLambda.value) || SETTINGS_DEFAULTS.detection.stabilizationLambda)),
    markerlessAutocorrelationBlurScale: 1,
    markerlessPhaseX: Math.max(-0.4, Math.min(0.4, Number(dom.markerlessPhaseX.value) || SETTINGS_DEFAULTS.detection.markerlessPhaseX)),
    markerlessPhaseY: Math.max(-0.4, Math.min(0.4, Number(dom.markerlessPhaseY.value) || SETTINGS_DEFAULTS.detection.markerlessPhaseY)),
    verticalDriftCompensation: Math.max(
      -0.05,
      Math.min(
        0.05,
        Number(dom.verticalDriftCompensation?.value) || SETTINGS_DEFAULTS.detection.verticalDriftCompensation
      )
    ),
    markerlessUseDarkness: dom.markerlessUseDarkness ? dom.markerlessUseDarkness.checked : true,
    markerlessUseTexture: dom.markerlessUseTexture ? dom.markerlessUseTexture.checked : true,
    markerlessUseVariance: dom.markerlessUseVariance ? dom.markerlessUseVariance.checked : true,
    lightOnDarkDesign: dom.lightOnDarkDesign ? dom.lightOnDarkDesign.checked : false,
    detectCrossesWithConvolution: (dom.alignmentPipelineMarkers.checked && dom.alignmentMarkerType.value === "crosses") && dom.detectCrossesWithConvolution.checked,
    useCrossAlignment: perFrameModeActive
      ? false
      : dom.alignmentPipelineMarkerless.checked
      ? true
      : dom.useCrossAlignment.checked,
    useRectifiedAsSource: false,
    crop: {
      left: Math.max(0, Math.round(Number(dom.cropLeft.value) || 0)),
      right: Math.max(0, Math.round(Number(dom.cropRight.value) || 0)),
      top: Math.max(0, Math.round(Number(dom.cropTop.value) || 0)),
      bottom: Math.max(0, Math.round(Number(dom.cropBottom.value) || 0)),
    },
    postCropGeometry: {
      flipHorizontal: dom.flipHorizontal.checked,
      flipVertical: dom.flipVertical.checked,
      rotate90Cw: dom.rotate90Cw.checked,
    },
    filters: {
      brightness: Number(dom.brightness.value) || SETTINGS_DEFAULTS.appearance.brightness,
      contrast: Number(dom.contrast.value) || SETTINGS_DEFAULTS.appearance.contrast,
      vibrance: Number(dom.vibrance.value) || SETTINGS_DEFAULTS.appearance.vibrance,
      temperature: Number(dom.temperature.value) || SETTINGS_DEFAULTS.appearance.temperature,
      unsharpRadius: Math.max(0.1, Math.min(100, Number(dom.unsharpRadius.value) || SETTINGS_DEFAULTS.appearance.unsharpRadius)),
      unsharpAmount: Math.max(0, Math.min(500, Number(dom.unsharpAmount.value) || SETTINGS_DEFAULTS.appearance.unsharpAmount)),
      invert: dom.invert.checked,
    },
    fps: Math.max(1, Math.min(60, Math.round(Number(dom.fps.value) || SETTINGS_DEFAULTS.gifExport.fps))),
    exportOptions: {
      loopCount: Math.max(1, Math.min(10, Math.round(Number(dom.loopCount.value) || SETTINGS_DEFAULTS.gifExport.loopCount))),
      outputWidthPx: getRequestedOutputSize().width,
      outputHeightPx: getRequestedOutputSize().height,
      outputScale: getRequestedOutputSize().scale,
      encodingQuality,
      quality: mapEncodingQualityToGifEncoderQuality(encodingQuality),
      mp4Quality: encodingQuality,
      dither: (dom.gifDither.value && dom.gifDither.value !== "off") ? dom.gifDither.value : false,
      resampling: dom.gifResampling.value || "linear",
      globalPalette: dom.gifGlobalPalette.checked,
      reverseOrder: dom.reverseOrder.checked,
      boustrophedonOrder: dom.boustrophedonOrder.checked,
      pingPong: dom.pingPong.checked,
      frameCountToExport: Math.max(
        1,
        Math.min(
          sourceFrameCount,
          Math.round(Number(dom.frameCountToExport?.value) || sourceFrameCount)
        )
      ),
    },
  };
  config.manualPageQuadPoints = getManualPageContourForProcessing();
  // The live threshold preview can rescue a full-pipeline page-detection failure, but it must not
  // masquerade as a manual override or it can bypass high-resolution detection after slider use.
  config.fallbackPageQuadPoints = config.manualPageQuadPoints ? null : getMatchingThresholdPreviewPageContour(config);
  return config;
}

/**
 * Clamp the paper aspect ratio to a sane range so custom sheets cannot request pathological
 * page geometries. Paper dimensions are treated as aspect-ratio hints, not real-world units.
 *
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
function clampPaperAspect(width, height) {
  const safeWidth = Math.max(1e-6, Number(width) || SETTINGS_DEFAULTS.layout.paperWidth);
  const safeHeight = Math.max(1e-6, Number(height) || SETTINGS_DEFAULTS.layout.paperHeight);
  return Math.max(0.25, Math.min(4.0, safeWidth / safeHeight));
}

/**
 * Return a compact signature for the effective paper geometry currently implied by the UI.
 *
 * This is used to avoid unnecessary reprocessing when the user switches between a preset and
 * `Custom` without actually changing the sheet dimensions.
 *
 * @returns {string}
 */
function getPaperGeometrySignature() {
  const config = readConfig();
  return `${config.paperWidthIn}x${config.paperHeightIn}`;
}

/**
 * Return the current paper-orientation selection. Presets use this to swap their displayed
 * and effective width/height ordering without changing the underlying preset catalog.
 *
 * @returns {"landscape"|"portrait"}
 */
function getPaperOrientation() {
  return dom.paperOrientationPortrait.checked ? "portrait" : "landscape";
}

/**
 * Resolve the effective width/height pair for one paper preset.
 *
 * Static presets live in `PAPER_PRESETS`; the `source` preset borrows the current raw image
 * dimensions so the sheet aspect ratio exactly matches the loaded source. These values are
 * only used for aspect math; choosing `source` does not allocate a canvas of that size.
 *
 * @param {string} presetKey
 * @returns {{width:number,height:number}|undefined}
 */
function getPaperPresetSize(presetKey) {
  if (presetKey === "source") {
    const width = Math.round(
      state.source.canvas?.width ||
      state.source.image?.naturalWidth ||
      0
    );
    const height = Math.round(
      state.source.canvas?.height ||
      state.source.image?.naturalHeight ||
      0
    );
    if (width > 0 && height > 0) {
      return { width, height };
    }
    return {
      width: SETTINGS_DEFAULTS.layout.paperWidth,
      height: SETTINGS_DEFAULTS.layout.paperHeight,
    };
  }
  return PAPER_PRESETS[presetKey];
}

/**
 * Format one preset option label using the active paper orientation. Custom stays unchanged.
 *
 * @param {string} presetKey
 * @returns {string}
 */
function formatPaperPresetLabel(presetKey) {
  if (presetKey === "custom") return t("layout.presetNames.custom");
  if (presetKey === "source") {
    if (!(state.source.canvas?.width > 0 && state.source.canvas?.height > 0)) {
      return t("layout.presetNames.source");
    }
    const sourceSize = getPaperPresetSize("source");
    if (!sourceSize) return t("layout.presetNames.source");
    return `${t("layout.presetNames.source")} (${sourceSize.width}:${sourceSize.height})`;
  }
  const preset = PAPER_PRESETS[presetKey];
  if (!preset) return presetKey;
  const orientation = getPaperOrientation();
  const width = orientation === "portrait" ? preset.height : preset.width;
  const height = orientation === "portrait" ? preset.width : preset.height;
  const units = preset.width > 100 ? t("layout.units.mm") : t("layout.units.in");
  return `${t(`layout.presetNames.${presetKey}`)} (${width}×${height} ${units})`;
}

/**
 * Show or hide the custom paper size fields based on the current preset selection, refresh
 * the preset labels for the current orientation, and disable orientation when Custom is active.
 *
 * @returns {void}
 */
function syncPaperPresetUi() {
  const presetKey = dom.paperPreset.value || "letter";
  const isCustom = presetKey === "custom";
  const isSource = presetKey === "source";
  const preset = getPaperPresetSize(presetKey);
  const orientation = getPaperOrientation();
  dom.paperPresetLabel.textContent = t("layout.paperSize");
  Array.from(dom.paperPreset.options).forEach((option) => {
    option.textContent = formatPaperPresetLabel(option.value);
  });
  dom.customPaperFields.hidden = !isCustom;
  dom.paperWidth.disabled = !isCustom;
  dom.paperHeight.disabled = !isCustom;
  dom.paperOrientationLandscape.disabled = isCustom || isSource;
  dom.paperOrientationPortrait.disabled = isCustom || isSource;
  if (!isCustom && preset) {
    const width = isSource ? preset.width : (orientation === "portrait" ? preset.height : preset.width);
    const height = isSource ? preset.height : (orientation === "portrait" ? preset.width : preset.height);
    dom.paperWidth.value = String(width);
    dom.paperHeight.value = String(height);
  }
}

function getActiveAlignmentPipeline() {
  if (isPerFrameModeActive()) return "per-frame";
  return dom.alignmentPipelineMarkerless.checked ? "markerless" : "markers";
}

/**
 * Preserve the markerless default of zero Grid Search Inset X/Y when switching away from marker mode.
 *
 * @param {"markerless"|"markers"|"per-frame"} pipeline
 * @returns {void}
 */
function applyAlignmentPipelineDefaults(pipeline) {
  if (
    pipeline === "markerless" &&
    dom.paperMarginX &&
    dom.paperMarginY &&
    Number(dom.paperMarginX.value) === SETTINGS_DEFAULTS.detection.paperMarginXPx &&
    Number(dom.paperMarginY.value) === SETTINGS_DEFAULTS.detection.paperMarginYPx
  ) {
    // Markerless mode defaults to no search inset. Preserve any non-default user/saved value.
    dom.paperMarginX.value = "0";
    dom.paperMarginY.value = "0";
  }
}

/**
 * Ensure marker-pipeline-only controls hold a valid state before being shown again.
 *
 * @param {"markerless"|"markers"|"per-frame"} pipeline
 * @returns {void}
 */
function sanitizeAlignmentPipelineState(pipeline) {
  if (
    pipeline === "markers" &&
    dom.alignmentMarkerType.value !== "auto" &&
    dom.alignmentMarkerType.value !== "crosses" &&
    dom.alignmentMarkerType.value !== "circles"
  ) {
    dom.alignmentMarkerType.value = SETTINGS_DEFAULTS.detection.alignmentMarkerType;
  }
}

/**
 * Return which alignment-specific control groups should be visible for the active pipeline.
 *
 * `showMarkerlessControls` stays strictly markerless-only (markerless gutter/phase/working-image
 * diagnostics must not leak into per-frame mode). `showFrameCornerControls` is the broader
 * "non-marker" family (markerless + per-frame) that shares stabilization, drift compensation and the
 * Frame Corners override editor. `isPerFrame` lets callers hide markerless-only controls that the
 * non-marker family would otherwise reveal (e.g. gutter sliders, Grid Edge controls).
 *
 * @param {"markerless"|"markers"|"per-frame"} pipeline
 * @returns {{showMarkerlessControls:boolean,showMarkersPipelineControls:boolean,showCrossOnlyControls:boolean,showFrameCornerControls:boolean,isPerFrame:boolean}}
 */
function getAlignmentUiModeFlags(pipeline) {
  document.body.classList.toggle("markerless-pipeline", pipeline === "markerless");
  document.body.classList.toggle("per-frame-pipeline", pipeline === "per-frame");
  const markerType = dom.alignmentMarkerType.value || SETTINGS_DEFAULTS.detection.alignmentMarkerType;
  const resolvedAutoType = state.geometry.alignmentInfo?.resolvedMarkerType || null;
  const showMarkersPipelineControls = pipeline === "markers";
  const showCrossOnlyControls = showMarkersPipelineControls && (markerType === "crosses" || (markerType === "auto" && resolvedAutoType === "crosses"));
  const showMarkerlessControls = pipeline === "markerless";
  const isPerFrame = pipeline === "per-frame";
  const showFrameCornerControls = pipeline !== "markers";
  return {
    showMarkerlessControls,
    showMarkersPipelineControls,
    showCrossOnlyControls,
    showFrameCornerControls,
    isPerFrame,
  };
}

/**
 * Rewrite alignment-related labels so the UI language matches the active pipeline.
 *
 * Per-frame mode shares the corner/stabilization mental model with markerless mode, so the
 * non-marker label family (`showFrameCornerControls`) drives the Frame Corners heading, the
 * stabilize/centers viewer tabs and the ROI-size label. `showMarkerlessControls` is reserved for
 * the markerless-only "summaryMarkerless" copy that mentions gutter fitting, which does not apply
 * to per-frame's synthetic exact grid.
 *
 * @param {{showMarkerlessControls:boolean,showFrameCornerControls:boolean,isPerFrame:boolean}} flags
 * @returns {void}
 */
function syncAlignmentPipelineLabels(flags) {
  const { showMarkerlessControls, showFrameCornerControls, isPerFrame } = flags;
  const frameAlignmentSummary = document.querySelector("#frameAlignmentSummary");
  const frameAlignmentSummaryLabel =
    frameAlignmentSummary?.querySelector("[data-i18n='alignment.summary']") ||
    frameAlignmentSummary?.firstElementChild;
  const dropGuidanceNote = document.querySelector("#dropGuidanceNote");
  if (frameAlignmentSummaryLabel) {
    frameAlignmentSummaryLabel.textContent = showMarkerlessControls ? t("alignment.summaryMarkerless") : t("alignment.summary");
  }
  if (dropGuidanceNote) {
    dropGuidanceNote.textContent = isPerFrame ? t("photo.dropNotePerFrame") : t("photo.dropNote");
  }
  const isMobileViewerMode = state.runtime.mobileSingleViewerMode;
  const headingText = isMobileViewerMode
    ? t(showFrameCornerControls ? "viewerTabs.centers" : "viewerTabs.markers")
    : t(showFrameCornerControls ? "panels.frameCorners" : "panels.frameAlignmentMarkers");
  if (dom.crossRegionsHeading) {
    const label = dom.crossRegionsHeading.querySelector("[data-panel-heading]") || dom.crossRegionsHeading.firstElementChild;
    if (label) label.textContent = headingText;
  }
  if (dom.viewerTabMarkers) {
    const viewerTabKey = showFrameCornerControls ? "viewerTabs.centers" : "viewerTabs.markers";
    dom.viewerTabMarkers.textContent = t(viewerTabKey);
  }
  if (dom.mobileControlTabAlignment) {
    const mobileControlTabKey = showFrameCornerControls ? "mobileControlTabs.stabilize" : "mobileControlTabs.markers";
    dom.mobileControlTabAlignment.textContent = t(mobileControlTabKey);
  }
  if (dom.crossRoiScaleLabel) {
    dom.crossRoiScaleLabel.textContent = showFrameCornerControls
      ? t("alignment.frameCornerRoiSize")
      : t("alignment.roiSize");
  }
  const markerlessPhaseXLabel =
    dom.markerlessPhaseXRow?.querySelector("[data-i18n='alignment.markerlessPhaseX']") ||
    dom.markerlessPhaseXRow?.querySelector("span span");
  if (markerlessPhaseXLabel) {
    markerlessPhaseXLabel.textContent = t("alignment.markerlessPhaseXOffset");
  }
  const markerlessPhaseYLabel =
    dom.markerlessPhaseYRow?.querySelector("[data-i18n='alignment.markerlessPhaseY']") ||
    dom.markerlessPhaseYRow?.querySelector("span span");
  if (markerlessPhaseYLabel) {
    markerlessPhaseYLabel.textContent = t("alignment.markerlessPhaseYOffset");
  }
  syncAlignmentModeTooltips(showFrameCornerControls);
}

/**
 * Keep shared tooltip text aligned with the active pipeline when marker terminology becomes
 * corner/stabilization terminology in the non-marker (markerless / per-frame) pipelines.
 *
 * @param {boolean} showFrameCornerControls
 * @returns {void}
 */
function syncAlignmentModeTooltips(showFrameCornerControls) {
  const applyTooltip = (element, key, extraElements = []) => {
    if (!element) return;
    const text = t(`tooltip.${key}`);
    const targets = [element, ...extraElements].filter(Boolean);
    if (Array.isArray(state.runtime.tooltipRegistry)) {
      for (const entry of state.runtime.tooltipRegistry) {
        if (targets.includes(entry[0])) entry[1] = text;
      }
    }
    for (const target of targets) {
      if (state.runtime.tooltipsEnabled && String(text || "").trim()) {
        target.title = text;
      } else {
        target.removeAttribute("title");
      }
    }
  };

  applyTooltip(
    document.querySelector("#frameAlignmentSummary"),
    showFrameCornerControls ? "frameAlignmentSummaryMarkerless" : "frameAlignmentSummary",
  );
  applyTooltip(
    dom.crossRegionsHeading,
    showFrameCornerControls ? "crossRegionsHeadingMarkerless" : "crossRegionsHeading",
  );
  applyTooltip(
    dom.crossRoiScale,
    showFrameCornerControls ? "crossRoiScaleMarkerless" : "crossRoiScale",
    [dom.crossRoiScale?.closest("label")],
  );
  applyTooltip(
    dom.toggleMarkerEditingButton,
    showFrameCornerControls ? "toggleMarkerEditingButtonMarkerless" : "toggleMarkerEditingButton",
  );
  applyTooltip(
    dom.clearMarkerEditsButton,
    showFrameCornerControls ? "clearMarkerEditsButtonMarkerless" : "clearMarkerEditsButton",
  );
}

/**
 * Keep the shared ROI-size slider in the right position for the active alignment mode.
 *
 * Per-frame mode shares the markerless Frame Corners layout, so the corner ROI slider sits at the
 * bottom of the stack for both non-marker pipelines.
 *
 * @param {{showFrameCornerControls:boolean}} flags
 * @returns {void}
 */
function syncAlignmentSliderOrder(flags) {
  const { showFrameCornerControls } = flags;
  if (dom.alignmentSliderStack && dom.crossRoiScaleRow) {
    if (showFrameCornerControls) {
      dom.alignmentSliderStack.appendChild(dom.crossRoiScaleRow);
    } else {
      dom.alignmentSliderStack.prepend(dom.crossRoiScaleRow);
    }
  }
}

/**
 * Show or hide the alignment controls appropriate for the active pipeline.
 *
 * Three control families:
 * - Stabilization + Vertical Drift Compensation are the shared non-marker family
 *   (`showFrameCornerControls`): visible in markerless AND per-frame.
 * - Grid Edge Threshold / Run Length are marker-only grid controls: shown only in markers
 *   (`showMarkersPipelineControls`), so they are hidden in BOTH markerless and per-frame.
 * - Markerless gutter/phase sliders (`markerlessPhase*Row`) stay markerless-only
 *   (`showMarkerlessControls`): hidden in per-frame because the synthetic grid needs no phase sweep.
 *
 * @param {{showMarkerlessControls:boolean,showMarkersPipelineControls:boolean,showCrossOnlyControls:boolean,showFrameCornerControls:boolean}} flags
 * @returns {void}
 */
function syncAlignmentPipelineVisibility(flags) {
  const { showMarkerlessControls, showMarkersPipelineControls, showCrossOnlyControls, showFrameCornerControls } = flags;
  // Grid Edge Threshold / Run Length are marker-grid controls: keep visible only in markers mode so
  // per-frame (which has no detected grid edges) hides them alongside markerless.
  dom.boundarySensitivityRow.hidden = !showMarkersPipelineControls;
  dom.boundaryPersistenceRow.hidden = !showMarkersPipelineControls;
  if (dom.stabilizationMethodGroup) {
    dom.stabilizationMethodGroup.hidden = !showFrameCornerControls;
  }
  if (dom.stabilizationEnabledRow) {
    dom.stabilizationEnabledRow.hidden = !showFrameCornerControls;
  }
  if (dom.stabilizationStrengthRow) {
    dom.stabilizationStrengthRow.hidden = !showFrameCornerControls;
  }
  dom.alignmentMarkerTypeField.hidden = !showMarkersPipelineControls;
  // Keep marker subpixel alignment as a settings-file/default option, not a visible UI control.
  dom.useCrossAlignmentRow.hidden = true;
  dom.detectCrossesWithConvolutionRow.hidden = !showCrossOnlyControls;
  dom.stabilizationLambdaRow.hidden = !showFrameCornerControls;
  // Markerless gutter/phase sweep sliders remain markerless-only; per-frame's exact grid skips them.
  dom.markerlessPhaseXRow.hidden = !showMarkerlessControls;
  dom.markerlessPhaseYRow.hidden = !showMarkerlessControls;
  if (dom.markerlessPhaseDebugRow) {
    dom.markerlessPhaseDebugRow.hidden = true;
  }
  if (dom.markerlessUseDarknessRow) {
    dom.markerlessUseDarknessRow.hidden = true;
  }
  if (dom.markerlessUseTextureRow) {
    dom.markerlessUseTextureRow.hidden = true;
  }
  if (dom.markerlessUseVarianceRow) {
    dom.markerlessUseVarianceRow.hidden = true;
  }
  dom.verticalDriftCompensationRow.hidden = !showFrameCornerControls;
}

/**
 * Enable only the stabilization controls that apply to the current method.
 *
 * `Stabilization Rigidity` (`lambda`) only affects the pairwise/cyclic least-squares solve. The
 * alternate average-reference method does not use it, so the slider should be visibly inactive in
 * that mode to avoid implying that it has any effect. Per-frame mode runs the same stabilization
 * solver as markerless, so it shares this gating via `showFrameCornerControls`.
 *
 * @param {{showFrameCornerControls:boolean}} flags
 * @returns {void}
 */
function syncStabilizationMethodUi(flags) {
  const { showFrameCornerControls } = flags;
  const usesLambda =
    showFrameCornerControls &&
    (dom.stabilizationMethodPairwise?.checked || !dom.stabilizationMethodAverage?.checked);
  if (dom.stabilizationLambda) {
    dom.stabilizationLambda.disabled = !usesLambda;
  }
  if (dom.stabilizationLambdaRow) {
    dom.stabilizationLambdaRow.classList.toggle("is-disabled", !usesLambda);
    dom.stabilizationLambdaRow.setAttribute("aria-disabled", usesLambda ? "false" : "true");
  }
}

/**
 * Clear or collapse inactive alignment-only diagnostics when the active pipeline changes.
 *
 * @param {{showCrossOnlyControls:boolean}} flags
 * @returns {void}
 */
function resetInactiveAlignmentUiState(flags) {
  const { showCrossOnlyControls } = flags;
  if (!showCrossOnlyControls) {
    dom.detectCrossesWithConvolution.checked = false;
  } else if (state.runtime.markerBlobDebugVisible) {
    state.runtime.markerBlobDebugVisible = false;
    if (state.geometry.alignmentInfo) {
      renderCrossRoiGrid(state.geometry.alignmentInfo);
    }
  }
}

/**
 * Reconfigure the alignment UI for the active pipeline.
 *
 * Markerless mode intentionally presents a different mental model from marker mode:
 * - the subpanel becomes "Stabilization"
 * - marker-type controls disappear
 * - gutter / phase / stabilization controls appear
 * - the marker tile panel is relabeled as Frame Corners, even though it still reuses the same
 *   underlying tile widget and override machinery
 *
 * @returns {void}
 */
function syncAlignmentMarkerUi() {
  const pipeline = getActiveAlignmentPipeline();
  applyAlignmentPipelineDefaults(pipeline);
  sanitizeAlignmentPipelineState(pipeline);
  const flags = getAlignmentUiModeFlags(pipeline);
  syncAlignmentPipelineLabels(flags);
  syncAlignmentSliderOrder(flags);
  syncAlignmentPipelineVisibility(flags);
  syncStabilizationMethodUi(flags);
  resetInactiveAlignmentUiState(flags);
  if (state.runtime.markerlessPhaseDebugVisible) {
    state.runtime.markerlessPhaseDebugVisible = false;
    resetMarkerlessDebugTimer("markerlessPhaseDebugTimer");
    if (state.preview.rectifiedCanvas) {
      renderRectifiedPreview(state.preview.rectifiedCanvas);
    }
  }
  if (state.runtime.markerlessWorkingImageVisible && pipeline !== "markerless") {
    state.runtime.markerlessWorkingImageVisible = false;
    resetMarkerlessDebugTimer("markerlessWorkingImageTimer");
    if (state.preview.rectifiedCanvas) {
      renderRectifiedPreview(state.preview.rectifiedCanvas);
    }
  }
  syncMarkerlessPhaseDebugUi();
  // Keep the per-frame strip's visibility + thumbnails in sync with the active pipeline. Idempotent:
  // hides/empties the strip in markers/markerless modes and only rebuilds on real image[] changes.
  renderPerFrameStrip();
}

/**
 * Show or hide MP4-specific export controls based on browser support.
 *
 * @returns {void}
 */
function syncMp4ExportUi() {
  const supported = !!state.runtime.mp4ExportSupported;
  dom.exportMp4Button.hidden = false;
  if (!supported) {
    dom.exportMp4Button.disabled = true;
    dom.exportMp4Button.title = t("panels.mp4Unsupported");
  } else {
    dom.exportMp4Button.removeAttribute("title");
  }
}

/**
 * Toggle manual marker-editing mode on or off.
 *
 * @returns {void}
 */
function toggleMarkerEditing() {
  if (!state.geometry.alignmentInfo) return;
  state.runtime.markerEditingEnabled = !state.runtime.markerEditingEnabled;
  syncMarkerEditingUi();
  renderCrossRoiGrid(state.geometry.alignmentInfo);
}

/**
 * Toggle manual page-corner editing in the Page Corners panel.
 *
 * @returns {void}
 */
function togglePageCornerEditing() {
  if (!state.source.image) return;
  const enabling = !state.runtime.pageCornerEditingEnabled;
  state.runtime.pageCornerEditingEnabled = enabling;
  state.preview.activePageCornerDrag = null;
  if (enabling && shouldSeedDefaultPageContour()) {
    seedDefaultManualPageContour();
    cancelPageCornerOverrideDependentWork();
    revokeGifUrl();
    updatePageGridDetectionHeading(false);
    scheduleProcess(0);
  }
  syncPageCornerEditingUi();
  renderRawPreview();
}

/**
 * Remove the manual page-corner override and rerun automatic page detection.
 *
 * @returns {void}
 */
function clearPageCornerEdits() {
  if (!Array.isArray(state.source.manualPageContour) || state.source.manualPageContour.length !== 4) return;
  // Clearing the override drops it from the active image entry too in per-frame mode (legacy-only
  // otherwise). Subsequent reprocessing re-detects this image's page automatically.
  setActiveManualPageContour(state, null, isPerFrameModeActive());
  state.preview.activePageCornerDrag = null;
  state.runtime.pageCornerEditingEnabled = false;
  cancelPageCornerOverrideDependentWork();
  revokeGifUrl();
  syncPageCornerEditingUi();
  previewPageBoundaryForThresholdOffset();
  scheduleProcess(0);
}

/**
 * Toggle the marker tiles between grayscale ROIs and binarized dot-blob diagnostics.
 *
 * @returns {void}
 */
function toggleMarkerBlobView() {
  if (!state.geometry.alignmentInfo?.crossRoiTiles?.some((tile) => tile.blobCanvas)) return;
  state.runtime.markerBlobDebugVisible = !state.runtime.markerBlobDebugVisible;
  syncMarkerEditingUi();
  renderCrossRoiGrid(state.geometry.alignmentInfo);
}

/**
 * Toggle the temporary markerless phase-debug overlay and refresh the rectified-sheet preview.
 *
 * @returns {void}
 */
function toggleMarkerlessPhaseDebug() {
  if (readConfig().alignmentPipeline !== "markerless") return;
  state.runtime.markerlessPhaseDebugVisible = !state.runtime.markerlessPhaseDebugVisible;
  if (state.runtime.markerlessPhaseDebugVisible) {
    resetMarkerlessDebugTimer("markerlessPhaseDebugTimer", () => {
      state.runtime.markerlessPhaseDebugVisible = false;
      syncMarkerlessPhaseDebugUi();
      if (state.preview.rectifiedCanvas) {
        renderRectifiedPreview(state.preview.rectifiedCanvas);
      }
    });
  } else {
    resetMarkerlessDebugTimer("markerlessPhaseDebugTimer");
  }
  syncMarkerlessPhaseDebugUi();
  if (state.preview.rectifiedCanvas) {
    renderRectifiedPreview(state.preview.rectifiedCanvas);
  }
}

/**
 * Toggle display of the reduced blurred markerless working image in Rectified Grid.
 *
 * This temporary debug view shows the reduced, blurred grayscale image used for markerless pitch
 * and phase estimation. Rectified-sheet overlays are skipped while active because the working
 * image is not in full rectified-sheet coordinates.
 *
 * @returns {void}
 */
function toggleMarkerlessWorkingImage() {
  if (readConfig().alignmentPipeline !== "markerless") return;
  state.runtime.markerlessWorkingImageVisible = !state.runtime.markerlessWorkingImageVisible;
  if (state.runtime.markerlessWorkingImageVisible) {
    resetMarkerlessDebugTimer("markerlessWorkingImageTimer", () => {
      state.runtime.markerlessWorkingImageVisible = false;
      if (state.preview.rectifiedCanvas) {
        renderRectifiedPreview(state.preview.rectifiedCanvas);
      }
    });
  } else {
    resetMarkerlessDebugTimer("markerlessWorkingImageTimer");
  }
  if (state.preview.rectifiedCanvas) {
    renderRectifiedPreview(state.preview.rectifiedCanvas);
  }
}

/**
 * Remove all saved manual marker overrides and re-render from the current auto-detected markers.
 *
 * @returns {void}
 */
function clearMarkerEdits() {
  if (!state.geometry.manualMarkerOverrides.size) return;
  state.geometry.manualMarkerOverrides.clear();
  state.preview.activeEditedMarker = null;
  state.runtime.markerEditingEnabled = false;
  // Non-marker pipelines (markerless + per-frame) store overrides as corner nudges, so they take the
  // same cache-clearing revert path; only true marker mode patches the live marker objects in place.
  const usesCornerNudges = readConfig().alignmentPipeline !== "markers";
  if (state.geometry.alignmentInfo && !usesCornerNudges) {
    // Original auto-detected positions are cached on the live alignment objects so edits can revert instantly
    // without rerunning the whole detector.
    for (const [key, marker] of state.geometry.alignmentInfo.markerLookup.entries()) {
      if (Number.isFinite(marker.autoDetectedX)) {
        marker.detectedX = marker.autoDetectedX;
        marker.detectedY = marker.autoDetectedY;
        marker.manualOverride = false;
      }
      const tile = state.geometry.alignmentInfo.crossRoiTileMap?.get(key);
      if (tile && Number.isFinite(tile.autoDetectedX)) {
        tile.detectedX = tile.autoDetectedX;
        tile.detectedY = tile.autoDetectedY;
        tile.manualOverride = false;
      }
    }
  }
  revokeGifUrl();
  if (usesCornerNudges) {
    state.frames.base = new Array(state.geometry.frameCount);
    state.frames.baseOutputEpoch = new Array(state.geometry.frameCount);
    state.frames.stabilizedCache.clear();
    state.frames.stabilizedOutputEpoch.clear();
    state.frames.phaseAdjustedCache.clear();
    state.frames.adjustedCache.clear();
    state.frames.adjustedOutputEpoch.clear();
  } else {
    invalidateFrameCaches();
  }
  syncMarkerEditingUi();
  renderCrossRoiGrid(state.geometry.alignmentInfo);
  scheduleStabilizationPreviewUpdate();
  scheduleCurrentPreviewFrameWarmup();
}

function loadCompanionSettingsText(src, filename, settingsFile = null) {
  return loadCompanionSettingsTextViaIo({
    src,
    filename,
    settingsFile,
    makeSettingsFilename,
  });
}

/**
 * Apply a standalone settings file without replacing the currently loaded image.
 *
 * If an image is already loaded, this reprocesses it using the new settings. If not, it simply
 * updates the UI so the next loaded image starts from those values.
 *
 * @param {File} file
 * @returns {Promise<void>}
 */
async function applySettingsFile(file) {
  if (!file) return;
  setBusyState(true);
  try {
    const settingsText = await file.text();
    applyLoadedSettingsText(settingsText);
    if (settingsText.trim()) {
      state.source.settingsLoaded = true;
      state.preview.rectifiedViewMode = "post";
    }
    revokeGifUrl();
    invalidateFrameCaches();
    invalidateAppearanceCache();
    if (state.source.image) {
      setStatus(`${t("status.loadedSettingsFile")}\n${t("status.reanalyzingPage")}`);
      await waitForNextPaint();
      state.processing.requestId += 1;
      await processCurrentImage(state.processing.requestId);
    } else {
      setStatus(`${t("status.loadedSettingsFile")}\n${t("status.loadImageToUseSettings")}`);
    }
  } catch (error) {
    console.error(error);
    setStatus(t("status.failedToLoadSettings", { message: error?.message || String(error) }));
  } finally {
    if (!state.processing.active && !state.processing.pending) {
      setBusyState(false);
    }
  }
}

function applyLoadedSettingsText(settingsText) {
  applyLoadedSettingsTextViaIo({
    settingsText,
    dom,
    state,
    settingsDefaults: SETTINGS_DEFAULTS,
    getMarkerKey,
    syncOutputSizeFromLoadedValues,
    syncOutputSizeFromWidthInput,
    syncOutputSizeFromHeightInput,
    syncPaperPresetUi,
    syncAlignmentMarkerUi,
    syncMarkerEditingUi,
    syncPageCornerEditingUi,
    syncRawPhotoCreditDisplay,
    updateSliderReadouts,
  });
}

/**
 * Refresh all live numeric readouts attached to sliders and similar controls.
 *
 * @returns {void}
 */
function updateSliderReadouts() {
  const frameCountFieldFocused = document.activeElement === dom.frameCountToExport;
  if (!frameCountFieldFocused) {
    syncFrameCountToExportUi();
  } else if (dom.frameCountToExport) {
    const maxFrameCount = getFrameExportCountMax();
    dom.frameCountToExport.min = "1";
    dom.frameCountToExport.max = String(maxFrameCount);
    state.runtime.lastFrameExportCountMax = maxFrameCount;
  }
  dom.brightnessValue.textContent = formatSignedValue(dom.brightness.value);
  dom.contrastValue.textContent = formatSignedValue(dom.contrast.value);
  dom.vibranceValue.textContent = formatSignedValue(dom.vibrance.value);
  dom.temperatureValue.textContent = formatSignedValue(dom.temperature.value);
  dom.unsharpRadiusValue.textContent = (Math.max(0.1, Math.min(100, Number(dom.unsharpRadius.value) || SETTINGS_DEFAULTS.appearance.unsharpRadius))).toFixed(1);
  dom.unsharpAmountValue.textContent = (Math.max(0, Math.min(500, Number(dom.unsharpAmount.value) || SETTINGS_DEFAULTS.appearance.unsharpAmount))).toFixed(1);
  dom.thresholdOffsetValue.textContent = formatSignedValue(dom.thresholdOffset.value);
  dom.paperMarginXValue.textContent = `${Math.max(
    0,
    Math.min(
      256,
      Number.isFinite(Number(dom.paperMarginX.value))
        ? Number(dom.paperMarginX.value)
        : SETTINGS_DEFAULTS.detection.paperMarginXPx
    )
  )} px`;
  dom.paperMarginYValue.textContent = `${Math.max(
    0,
    Math.min(
      256,
      Number.isFinite(Number(dom.paperMarginY.value))
        ? Number(dom.paperMarginY.value)
        : SETTINGS_DEFAULTS.detection.paperMarginYPx
    )
  )} px`;
  dom.boundarySensitivityValue.textContent = `${Math.max(0, Math.min(20, Number(dom.boundarySensitivity.value) || SETTINGS_DEFAULTS.detection.boundarySensitivity)).toFixed(1)}`;
  dom.boundaryPersistenceValue.textContent = String(Math.max(1, Math.min(15, Number(dom.boundaryPersistence.value) || SETTINGS_DEFAULTS.detection.boundaryPersistencePx)));
  if (dom.postRotationValue) {
    const postRotationDeg = Math.max(
      -1.1,
      Math.min(
        1.1,
        Number.isFinite(Number(dom.postRotation?.value))
          ? Number(dom.postRotation.value)
          : SETTINGS_DEFAULTS.detection.postRotationDeg
      )
    );
    dom.postRotationValue.textContent = `${postRotationDeg >= 0 ? "+" : ""}${postRotationDeg.toFixed(2)}°`;
  }
  if (dom.stabilizationStrengthValue) {
    const stabilizationStrengthPct = Math.max(
      0,
      Math.min(
        125,
        Number.isFinite(Number(dom.stabilizationStrength?.value))
          ? Math.round(Number(dom.stabilizationStrength.value))
          : SETTINGS_DEFAULTS.detection.stabilizationStrengthPct
      )
    );
    dom.stabilizationStrengthValue.textContent = `${stabilizationStrengthPct}%`;
  }
  dom.stabilizationLambdaValue.textContent = `${Math.max(0.001, Math.min(0.1, Number(dom.stabilizationLambda.value) || SETTINGS_DEFAULTS.detection.stabilizationLambda)).toFixed(3)}`;
  dom.markerlessPhaseXValue.textContent = formatSignedDecimal(Math.max(-0.4, Math.min(0.4, Number(dom.markerlessPhaseX.value) || SETTINGS_DEFAULTS.detection.markerlessPhaseX)));
  dom.markerlessPhaseYValue.textContent = formatSignedDecimal(Math.max(-0.4, Math.min(0.4, Number(dom.markerlessPhaseY.value) || SETTINGS_DEFAULTS.detection.markerlessPhaseY)));
  if (dom.verticalDriftCompensationValue) {
    dom.verticalDriftCompensationValue.textContent = `${formatSignedDecimal(
      Math.max(
        -0.05,
        Math.min(
          0.05,
          Number(dom.verticalDriftCompensation?.value) || SETTINGS_DEFAULTS.detection.verticalDriftCompensation
        )
      ) * 100
    )}%`;
  }
  const outputSize = getRequestedOutputSize();
  dom.outputWidth.value = outputSize.width > 0 ? String(outputSize.width) : "";
  dom.outputHeight.value = outputSize.height > 0 ? String(outputSize.height) : "";
  dom.gifQualityValue.textContent = String(getEncodingQualityValue());
  dom.cropAspectRatioValue.textContent = getCurrentCropAspectRatioText();
  if (!state.geometry.alignmentInfo) {
    dom.crossRoiScaleValue.textContent = "-- px";
    return;
  }
  const config = readConfig();
  const roiSizePx = config.alignmentPipeline !== "markers"
    ? estimateMarkerlessCornerTileSidePx(
        state.geometry.alignmentInfo.rectifiedWidth,
        state.geometry.alignmentInfo.rectifiedHeight,
        config.frameCols,
        config.frameRows,
        config.crossRoiScale,
        config.paperWidthIn * 100,
        config.paperHeightIn * 100
      )
    : estimateCrossRoiSidePx(
        state.geometry.alignmentInfo.rectifiedWidth,
        state.geometry.alignmentInfo.rectifiedHeight,
        config.frameCols,
        config.frameRows,
        config.crossRoiScale,
        config.paperWidthIn * 100,
        config.paperHeightIn * 100
      );
  dom.crossRoiScaleValue.textContent = `${roiSizePx}×${roiSizePx} px`;
}

/**
 * Clamp the export-frame-count control to the current source budget (grid cells or per-frame images).
 * If the control was still at the previous maximum, treat it as "use all frames" and advance it to
 * the new maximum automatically.
 *
 * This also covers legacy settings files that predate `Frames in Export`: an empty field is
 * interpreted as "export every available frame", not as a literal zero or one-frame request.
 *
 * @returns {number}
 */
function syncFrameCountToExportUi() {
  if (!dom.frameCountToExport) return 0;
  const maxFrameCount = getFrameExportCountMax();
  const previousMax = Math.max(1, state.runtime.lastFrameExportCountMax || maxFrameCount);
  const rawText = String(dom.frameCountToExport.value || "").trim();
  const rawValue = Number(rawText);
  let nextValue = rawValue;
  if (!rawText || !Number.isFinite(rawValue) || rawValue === previousMax) {
    nextValue = maxFrameCount;
  }
  nextValue = Math.max(1, Math.min(maxFrameCount, Math.round(nextValue)));
  dom.frameCountToExport.min = "1";
  dom.frameCountToExport.max = String(maxFrameCount);
  dom.frameCountToExport.value = String(nextValue);
  state.runtime.lastFrameExportCountMax = maxFrameCount;
  return nextValue;
}

/**
 * Format a numeric slider value with an explicit sign for display.
 *
 * @param {string | number} value
 * @returns {string}
 */
function formatSignedValue(value) {
  const number = Number(value) || 0;
  return (number >= 0 ? "+" : "") + number;
}

/**
 * Format a signed decimal readout with fixed precision.
 *
 * @param {number} value
 * @returns {string}
 */
function formatSignedDecimal(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : ""}${number.toFixed(3)}`;
}

/**
 * Return an overlay stroke width in backing-store pixels while preserving the intended CSS-pixel
 * thickness on HiDPI canvases.
 *
 * Standard-density screens keep the existing stroke widths. On `devicePixelRatio > 1`, selected
 * geometry overlays switch to a `1.5 px` visual stroke, which means scaling that width back up
 * into the canvas backing-store coordinate system.
 *
 * @param {number} standardCssPx
 * @returns {number}
 */
function getPanelOverlayStrokeWidth(standardCssPx) {
  const dpr = Math.max(1, Math.min(2, Number(globalThis.devicePixelRatio) || 1));
  return dpr > 1 ? (1.5 * dpr) : standardCssPx;
}

/**
 * Clamp an output-scale value to the supported typed/slider range.
 *
 * @param {number} value
 * @returns {number}
 */
function clampLegacyOutputScale(value) {
  return Math.max(0.25, Math.min(1.25, Number(value) || 1));
}

/**
 * Clamp a requested output dimension to the supported 1..1999 range.
 *
 * @param {number} value
 * @returns {number}
 */
function clampOutputDimension(value) {
  return Math.max(1, Math.min(1999, Math.round(Number(value) || 0)));
}

/**
 * Compute the current frame size after crop and post-crop rotation but before output scaling.
 *
 * @returns {{width:number,height:number}|null}
 */
function getCurrentOutputGeometrySize() {
  const alignmentInfo = state.geometry.alignmentInfo;
  if (!alignmentInfo) return null;
  const cellWidth = alignmentInfo.gridBounds.width / alignmentInfo.cols;
  const cellHeight = alignmentInfo.gridBounds.height / alignmentInfo.rows;
  const cropLeft = Math.max(0, Math.round(Number(dom.cropLeft.value) || 0));
  const cropRight = Math.max(0, Math.round(Number(dom.cropRight.value) || 0));
  const cropTop = Math.max(0, Math.round(Number(dom.cropTop.value) || 0));
  const cropBottom = Math.max(0, Math.round(Number(dom.cropBottom.value) || 0));
  const rotate90Cw = dom.rotate90Cw.checked;
  const croppedWidth = Math.max(1, Math.round(cellWidth - cropLeft - cropRight));
  const croppedHeight = Math.max(1, Math.round(cellHeight - cropTop - cropBottom));
  return rotate90Cw
    ? { width: croppedHeight, height: croppedWidth }
    : { width: croppedWidth, height: croppedHeight };
}

/**
 * Convert a requested width into a proportional final output size, clamped to 1999×1999.
 *
 * @param {{width:number,height:number}} geometrySize
 * @param {number} requestedWidth
 * @returns {{width:number,height:number,scale:number}}
 */
function resolveOutputSizeFromWidth(geometrySize, requestedWidth) {
  const unclampedWidth = clampOutputDimension(requestedWidth);
  const requestedScale = unclampedWidth / geometrySize.width;
  const maxScale = Math.min(1999 / geometrySize.width, 1999 / geometrySize.height);
  const scale = Math.min(requestedScale, maxScale);
  return {
    width: Math.max(1, Math.min(1999, Math.round(geometrySize.width * scale))),
    height: Math.max(1, Math.min(1999, Math.round(geometrySize.height * scale))),
    scale,
  };
}

/**
 * Convert a requested height into a proportional final output size, clamped to 1999×1999.
 *
 * @param {{width:number,height:number}} geometrySize
 * @param {number} requestedHeight
 * @returns {{width:number,height:number,scale:number}}
 */
function resolveOutputSizeFromHeight(geometrySize, requestedHeight) {
  const unclampedHeight = clampOutputDimension(requestedHeight);
  const requestedScale = unclampedHeight / geometrySize.height;
  const maxScale = Math.min(1999 / geometrySize.width, 1999 / geometrySize.height);
  const scale = Math.min(requestedScale, maxScale);
  return {
    width: Math.max(1, Math.min(1999, Math.round(geometrySize.width * scale))),
    height: Math.max(1, Math.min(1999, Math.round(geometrySize.height * scale))),
    scale,
  };
}

/**
 * Capture the current Output Width field as the controlling dimension.
 *
 * @returns {void}
 */
function syncOutputSizeFromWidthInput() {
  const geometrySize = getCurrentOutputGeometrySize();
  const parsed = clampOutputDimension(dom.outputWidth.value);
  if (!geometrySize) {
    state.runtime.outputSizeAuto = false;
    state.runtime.outputSizeAnchor = "width";
    state.runtime.outputWidthPx = parsed;
    state.runtime.outputHeightPx = 0;
    state.runtime.pendingOutputScale = null;
    return;
  }
  const resolved = resolveOutputSizeFromWidth(geometrySize, parsed);
  state.runtime.outputSizeAuto = false;
  state.runtime.outputSizeAnchor = "width";
  state.runtime.outputWidthPx = resolved.width;
  state.runtime.outputHeightPx = resolved.height;
  state.runtime.pendingOutputScale = null;
}

/**
 * Capture the current Output Height field as the controlling dimension.
 *
 * @returns {void}
 */
function syncOutputSizeFromHeightInput() {
  const geometrySize = getCurrentOutputGeometrySize();
  const parsed = clampOutputDimension(dom.outputHeight.value);
  if (!geometrySize) {
    state.runtime.outputSizeAuto = false;
    state.runtime.outputSizeAnchor = "height";
    state.runtime.outputWidthPx = 0;
    state.runtime.outputHeightPx = parsed;
    state.runtime.pendingOutputScale = null;
    return;
  }
  const resolved = resolveOutputSizeFromHeight(geometrySize, parsed);
  state.runtime.outputSizeAuto = false;
  state.runtime.outputSizeAnchor = "height";
  state.runtime.outputWidthPx = resolved.width;
  state.runtime.outputHeightPx = resolved.height;
  state.runtime.pendingOutputScale = null;
}

/**
 * Restore an exact output-size pair from a settings file before geometry is available.
 *
 * The settings manifest stores resolved width/height, not just one anchor dimension. Keep that
 * exact pair intact so later UI sync/export does not coerce it through width-only rounding.
 *
 * @param {number} width
 * @param {number} height
 * @returns {void}
 */
function syncOutputSizeFromLoadedValues(width, height) {
  state.runtime.outputSizeAuto = false;
  state.runtime.outputSizeAnchor = "exact";
  state.runtime.outputWidthPx = clampOutputDimension(width);
  state.runtime.outputHeightPx = clampOutputDimension(height);
  state.runtime.pendingOutputScale = null;
}

/**
 * Preserve the user's requested output-size pair when toggling post-crop 90-degree rotation.
 *
 * Automatic output sizing follows the rotated native frame geometry already. Manual sizing needs a
 * stored pair swap because the rotation is applied before final output scaling.
 *
 * @returns {void}
 */
function swapManualOutputSizeForRotate90() {
  if (state.runtime.outputSizeAuto) return;
  const readPositiveOutputDimension = (storedValue, fieldValue) => {
    const parsed = Number(fieldValue);
    if (Number.isFinite(parsed) && parsed > 0) return clampOutputDimension(parsed);
    return Number.isFinite(storedValue) && storedValue > 0 ? clampOutputDimension(storedValue) : 0;
  };
  const currentWidth =
    readPositiveOutputDimension(state.runtime.outputWidthPx, dom.outputWidth.value);
  const currentHeight =
    readPositiveOutputDimension(state.runtime.outputHeightPx, dom.outputHeight.value);
  if (currentWidth <= 0 || currentHeight <= 0) return;
  state.runtime.outputWidthPx = clampOutputDimension(currentHeight);
  state.runtime.outputHeightPx = clampOutputDimension(currentWidth);
  state.runtime.pendingOutputScale = null;
}

/**
 * Resolve the current final output size from the auto/manual state and current geometry.
 *
 * @returns {{width:number,height:number,scale:number}}
 */
function getRequestedOutputSize() {
  const geometrySize = getCurrentOutputGeometrySize();
  if (!geometrySize) {
    return { width: 0, height: 0, scale: 1 };
  }
  if (Number.isFinite(state.runtime.pendingOutputScale) && state.runtime.pendingOutputScale > 0) {
    return resolveOutputSizeFromWidth(
      geometrySize,
      Math.round(geometrySize.width * state.runtime.pendingOutputScale)
    );
  }
  if (state.runtime.outputSizeAuto) {
    return resolveOutputSizeFromWidth(geometrySize, geometrySize.width);
  }
  if (
    state.runtime.outputSizeAnchor === "exact" &&
    state.runtime.outputWidthPx > 0 &&
    state.runtime.outputHeightPx > 0
  ) {
    return {
      width: clampOutputDimension(state.runtime.outputWidthPx),
      height: clampOutputDimension(state.runtime.outputHeightPx),
      scale: state.runtime.outputWidthPx / geometrySize.width,
    };
  }
  if (state.runtime.outputSizeAnchor === "height" && state.runtime.outputHeightPx > 0) {
    return resolveOutputSizeFromHeight(geometrySize, state.runtime.outputHeightPx);
  }
  if (state.runtime.outputWidthPx > 0) {
    return resolveOutputSizeFromWidth(geometrySize, state.runtime.outputWidthPx);
  }
  if (state.runtime.outputHeightPx > 0) {
    return resolveOutputSizeFromHeight(geometrySize, state.runtime.outputHeightPx);
  }
  return resolveOutputSizeFromWidth(geometrySize, geometrySize.width);
}

/**
 * Run the full geometry/CV pipeline, update caches, and refresh all previews.
 *
 * @param {number} [requestId=state.processing.requestId]
 * @returns {Promise<void>}
 */
async function processCurrentImage(requestId = state.processing.requestId) {
  if (!state.runtime.cvReady) {
    setBusyState(false);
    setGeometryProcessingCursor(false);
    setStatus(t("status.openCvLoading"));
    return;
  }
  if (!state.source.image) return;
  if (state.processing.active) {
    state.processing.pending = true;
    return;
  }

  state.processing.active = true;
  cancelStabilizationMeasurement();
  cancelPreviewFrameWarmup();
  setBusyState(true);
  updateExportControlsAvailability(true);
  trimCachesBeforeReprocess();
  lastProcessTimingSummary = "";
  lastWarmupTimingSummary = "";
  lastHeavyPathTimingSummary = "";
  const timingProfile = beginTimingProfile("Process");

  try {
    const config = timeProfiled("readConfig", () => readConfig());
    const result = timeProfiled("runPipeline", () => runPipeline(state.source.canvas, config, requestId, throwIfProcessAborted, state.source.images));
    if (requestId !== state.processing.requestId) {
      finishTimingProfile(timingProfile);
      return;
    }

    timeProfiled("applyPipelineResult", () => {
      // `runPipeline()` returns raw extracted frame canvases at rectified-sheet/crop resolution.
      // Those are useful for status text (`Animation size`) but they do not yet include output-size
      // scaling or post-crop flip/rotation. Do not seed the live base-frame cache with them,
      // otherwise preview/export can incorrectly reuse native-size frames until a later UI change
      // invalidates the cache.
      state.frames.base = new Array(result.frames.length);
      state.frames.baseOutputEpoch = new Array(result.frames.length);
      state.frames.stabilizedCache.clear();
      state.frames.stabilizedOutputEpoch.clear();
      state.frames.phaseAdjustedCache.clear();
      state.frames.stabilizationMatchData = null;
      state.frames.stabilizationPairwise = null;
      state.frames.stabilizationAverageReference = null;
      state.frames.stabilizationOffsets = null;
      state.frames.adjustedOutputEpoch.clear();
      state.geometry.frameCount = result.frames.length;
      state.geometry.alignmentInfo = result.alignmentInfo;
      releaseRectifiedCvCache();
      state.geometry.baseRectifiedCanvas = result.rectifiedCanvas;
      state.geometry.baseRectifiedMat = result.rectifiedMat;
      state.geometry.baseRectifiedPageCanvas = result.pagePreviewCanvas;
      state.geometry.baseRectifiedPageWidth = result.pagePreviewWidth || result.pagePreviewCanvas?.width || 0;
      state.geometry.baseRectifiedPageHeight = result.pagePreviewHeight || result.pagePreviewCanvas?.height || 0;
      state.geometry.rectifiedDownloadUsesRawSource = !!result.rectifiedDownloadUsesRawSource;
      state.geometry.pagePreviewGridQuad = result.pagePreviewGridQuad;
      state.geometry.pagePreviewGridBounds = result.pagePreviewGridBounds || null;
      state.runtime.appliedPostRotationDeg = config.postRotationDeg;
      state.source.rawPageContour = result.pageQuadPoints;
      state.source.pageQuadSource = result.pageQuadSource || "pipeline-detection";
      stashOriginalMarkerDetections(state.geometry.alignmentInfo);
      applyManualMarkerOverrides(state.geometry.alignmentInfo);
      primeRectifiedFullResAssetIfSmall();
    });
    if (state.geometry.manualMarkerOverrides.size > 0) {
      timeProfiled("applyMarkerOverrides", () => {
        state.frames.base = new Array(result.frames.length);
        state.frames.baseOutputEpoch = new Array(result.frames.length);
        state.frames.stabilizedCache.clear();
        state.frames.stabilizedOutputEpoch.clear();
        state.frames.phaseAdjustedCache.clear();
        state.frames.stabilizationMatchData = null;
        state.frames.stabilizationPairwise = null;
        state.frames.stabilizationAverageReference = null;
        state.frames.stabilizationOffsets = null;
        state.frames.adjustedOutputEpoch.clear();
      });
    }
    if (state.preview.postRotationScrubbing) {
      timeProfiled("endPostRotationScrub", () => endPostRotationScrub());
    }
    timeProfiled("syncAlignmentUi", () => syncAlignmentMarkerUi());
    timeProfiled("invalidateAppearanceCache", () => invalidateAppearanceCache());
    timeProfiled("updateSliderReadouts", () => updateSliderReadouts());
    state.source.thresholdPreviewPageContour = null;
    state.source.thresholdPreviewSignature = "";
    timeProfiled("renderRawPreview", () => renderRawPreview());
    timeProfiled("refreshAppearanceOutputs", () => refreshAppearanceOutputs());
    timeProfiled("renderCrossRoiGrid", () => renderCrossRoiGrid(result.alignmentInfo));
    timeProfiled("drawCurrentGifPreview", () => drawCurrentGifPreview());
    timeProfiled("updateExportControls", () => updateExportControlsAvailability());
    timeProfiled("syncMarkerEditingUi", () => syncMarkerEditingUi());
    timeProfiled("updatePreviewPlayPauseButton", () => updatePreviewPlayPauseButton());
    timeProfiled("updateExportButtonLabel", () => updateExportButtonLabel());
    lastBaseStatusText = result.statusText;
    lastProcessTimingSummary = finishTimingProfile(timingProfile);
    updatePageGridDetectionHeading(false);
    setStatus(buildStatusWithTiming(result.statusText));
    schedulePreviewFrameWarmup(requestId);
    // Stabilization runs in both non-marker pipelines, so warm its solver after per-frame too.
    if (config.alignmentPipeline !== "markers") {
      scheduleMarkerlessStabilizationWarmup(requestId);
    }
  } catch (error) {
    finishTimingProfile(timingProfile);
    if (state.preview.postRotationScrubbing) {
      endPostRotationScrub();
    }
    if (error?.name !== "ProcessAbortedError") {
      const config = readConfig();
      const fallbackPageContour = getMatchingThresholdPreviewPageContour(config);
      if (Array.isArray(error?.partialResult?.pageQuadPoints) && error.partialResult.pageQuadPoints.length === 4) {
        state.source.rawPageContour = error.partialResult.pageQuadPoints;
        state.source.pageQuadSource = error.partialResult.pageQuadSource || "partial-result";
        renderRawPreview();
      } else if (fallbackPageContour) {
        state.source.rawPageContour = fallbackPageContour;
        state.source.pageQuadSource = "threshold-preview-display";
        renderRawPreview();
      } else {
        state.source.rawPageContour = null;
        state.source.pageQuadSource = "";
        renderRawPreview();
      }
      clearDerivedOutputsForDetectionFailure();
      if (!fallbackPageContour) {
        console.error(error);
      }
      updatePageGridDetectionHeading(true);
      updateExportButtonLabel();
      lastBaseStatusText = t("status.pageBoundaryFailure");
      lastProcessTimingSummary = "";
      lastWarmupTimingSummary = "";
      lastHeavyPathTimingSummary = "";
      setStatus(t("status.pageBoundaryFailure"));
    } else {
      lastProcessTimingSummary = "";
      lastWarmupTimingSummary = "";
      lastHeavyPathTimingSummary = "";
    }
  } finally {
    updateExportControlsAvailability();
    state.processing.active = false;
    if (state.processing.pending) {
      state.processing.pending = false;
      window.clearTimeout(state.processing.timer);
      setGeometryProcessingCursor(true);
      state.processing.timer = window.setTimeout(() => {
        void processCurrentImage(state.processing.requestId);
      }, 0);
    } else {
      setBusyState(false);
      setGeometryProcessingCursor(false);
    }
  }
}

/**
 * Throw a sentinel error if a stale processing pass is still running.
 *
 * @param {number} requestId
 * @returns {void}
 */
function throwIfProcessAborted(requestId) {
  if (requestId !== state.processing.requestId) {
    const error = new Error("Processing aborted.");
    error.name = "ProcessAbortedError";
    throw error;
  }
}

/**
 * Render the current rectified-sheet canvas into its preview panel.
 *
 * @param {HTMLCanvasElement} rectifiedCanvas
 * @returns {void}
 */
function renderRectifiedPreview(rectifiedCanvas) {
  updateRectifiedSheetHeading();
  dom.rectifiedCanvas.parentElement?.classList.remove("is-empty");
  const diagnosticSource = rectifiedCanvas;
  const markerlessWorkingCanvas =
    readConfig().alignmentPipeline === "markerless"
      ? (state.geometry.alignmentInfo?.markerlessEstimate?.workingBlurCanvas || null)
      : null;
  const showingMarkerlessWorkingImage =
    !!markerlessWorkingCanvas &&
    !state.preview.showRectifiedDiagnostic &&
    state.runtime.markerlessWorkingImageVisible;
  const previewPostRotationDeg = getPostRotationPreviewDeg();
  const showingPostRotationPreview =
    state.preview.postRotationScrubbing &&
    !state.preview.showRectifiedDiagnostic &&
    !showingMarkerlessWorkingImage &&
    Math.abs(previewPostRotationDeg) > 1e-9;
  const baseDisplayCanvas = state.preview.showRectifiedDiagnostic
    ? getRectifiedConvolutionCanvas(diagnosticSource)
    : (showingMarkerlessWorkingImage ? markerlessWorkingCanvas : rectifiedCanvas);
  const displayCanvas = showingPostRotationPreview
    ? getPostRotationPreviewCanvas(baseDisplayCanvas, previewPostRotationDeg)
    : baseDisplayCanvas;
  const showingPageWarpPreview =
    rectifiedCanvas === state.geometry.baseRectifiedPageCanvas &&
    !showingMarkerlessWorkingImage;
  updateMobileRectifiedAspectRatio(displayCanvas);
  const targetCanvas = dom.rectifiedCanvas;
  if (!showingPostRotationPreview) {
    renderCanvasFit(displayCanvas, targetCanvas);
  } else {
    resizeCanvasToBox(targetCanvas);
    const previewCtx = targetCanvas.getContext("2d");
    previewCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    previewCtx.imageSmoothingEnabled = true;
    previewCtx.imageSmoothingQuality = "high";
    const previewScale = Math.min(targetCanvas.width / displayCanvas.width, targetCanvas.height / displayCanvas.height);
    const previewDrawW = displayCanvas.width * previewScale;
    const previewDrawH = displayCanvas.height * previewScale;
    const previewOffsetX = (targetCanvas.width - previewDrawW) * 0.5;
    const previewOffsetY = (targetCanvas.height - previewDrawH) * 0.5;
    previewCtx.drawImage(displayCanvas, previewOffsetX, previewOffsetY, previewDrawW, previewDrawH);
  }
  const scale = Math.min(targetCanvas.width / displayCanvas.width, targetCanvas.height / displayCanvas.height);
  const drawW = displayCanvas.width * scale;
  const drawH = displayCanvas.height * scale;
  const offsetX = (targetCanvas.width - drawW) * 0.5;
  const offsetY = (targetCanvas.height - drawH) * 0.5;
  const fullRectifiedWidth = Math.max(
    1,
    Math.round(
      showingPageWarpPreview
        ? (state.geometry.baseRectifiedPageWidth || rectifiedCanvas.width || 1)
        : (state.geometry.baseRectifiedMat?.cols || rectifiedCanvas.width || 1)
    ),
  );
  const fullRectifiedHeight = Math.max(
    1,
    Math.round(
      showingPageWarpPreview
        ? (state.geometry.baseRectifiedPageHeight || rectifiedCanvas.height || 1)
        : (state.geometry.baseRectifiedMat?.rows || rectifiedCanvas.height || 1)
    ),
  );
  const overlayScaleX = drawW / fullRectifiedWidth;
  const overlayScaleY = drawH / fullRectifiedHeight;
  const ctx = targetCanvas.getContext("2d");
  const config = readConfig();
  const rotationRadians = showingPostRotationPreview ? (previewPostRotationDeg * (Math.PI / 180)) : 0;
  const mapDisplayPointToPreview = (point) => {
    const previewPoint = {
      x: point.x * (displayCanvas.width / fullRectifiedWidth),
      y: point.y * (displayCanvas.height / fullRectifiedHeight),
    };
    const rotatedPoint = showingPostRotationPreview
      ? rotateCanvasPointAroundCenter(previewPoint, displayCanvas.width, displayCanvas.height, rotationRadians)
      : previewPoint;
    return {
      x: offsetX + (rotatedPoint.x * (drawW / displayCanvas.width)),
      y: offsetY + (rotatedPoint.y * (drawH / displayCanvas.height)),
    };
  };
  const mapRectifiedPointToPreview = showingPageWarpPreview
    ? (point) => mapDisplayPointToPreview(mapRectifiedPointToPagePreview(point))
    : mapDisplayPointToPreview;

  ctx.save();
  if (showingMarkerlessWorkingImage) {
    ctx.restore();
    return;
  }
  if (showingPageWarpPreview && state.geometry.pagePreviewGridQuad) {
    const gridQuad = state.geometry.pagePreviewGridQuad;
    const tl = mapDisplayPointToPreview(gridQuad.tl);
    const tr = mapDisplayPointToPreview(gridQuad.tr);
    const br = mapDisplayPointToPreview(gridQuad.br);
    const bl = mapDisplayPointToPreview(gridQuad.bl);
    ctx.strokeStyle = "rgb(0, 90, 220)";
    ctx.lineWidth = getPanelOverlayStrokeWidth(1);
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.stroke();
  }
  if (showingPageWarpPreview) {
    const insetXPx = Math.max(
      0,
      Math.min(Math.floor(fullRectifiedWidth * 0.5) - 1, config.paperMarginXPx || 0)
    );
    const insetYPx = Math.max(
      0,
      Math.min(Math.floor(fullRectifiedHeight * 0.5) - 1, config.paperMarginYPx || 0)
    );
    const insetTl = mapDisplayPointToPreview({ x: insetXPx, y: insetYPx });
    const insetTr = mapDisplayPointToPreview({ x: fullRectifiedWidth - insetXPx, y: insetYPx });
    const insetBr = mapDisplayPointToPreview({ x: fullRectifiedWidth - insetXPx, y: fullRectifiedHeight - insetYPx });
    const insetBl = mapDisplayPointToPreview({ x: insetXPx, y: fullRectifiedHeight - insetYPx });
    ctx.strokeStyle = "rgba(255, 0, 255, 1)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(insetTl.x, insetTl.y);
    ctx.lineTo(insetTr.x, insetTr.y);
    ctx.lineTo(insetBr.x, insetBr.y);
    ctx.lineTo(insetBl.x, insetBl.y);
    ctx.closePath();
    ctx.stroke();
  }
  if (config.alignmentPipeline === "markerless" && !state.preview.showRectifiedDiagnostic) {
    const insetXPx = Math.max(
      0,
      Math.min(Math.floor(fullRectifiedWidth * 0.5) - 1, config.paperMarginXPx || 0)
    );
    const insetYPx = Math.max(
      0,
      Math.min(Math.floor(fullRectifiedHeight * 0.5) - 1, config.paperMarginYPx || 0)
    );
    const insetTl = mapRectifiedPointToPreview({ x: insetXPx, y: insetYPx });
    const insetTr = mapRectifiedPointToPreview({ x: fullRectifiedWidth - insetXPx, y: insetYPx });
    const insetBr = mapRectifiedPointToPreview({ x: fullRectifiedWidth - insetXPx, y: fullRectifiedHeight - insetYPx });
    const insetBl = mapRectifiedPointToPreview({ x: insetXPx, y: fullRectifiedHeight - insetYPx });
    ctx.strokeStyle = "rgb(0, 90, 220)";
    ctx.lineWidth = getPanelOverlayStrokeWidth(1);
    ctx.beginPath();
    ctx.moveTo(insetTl.x, insetTl.y);
    ctx.lineTo(insetTr.x, insetTr.y);
    ctx.lineTo(insetBr.x, insetBr.y);
    ctx.lineTo(insetBl.x, insetBl.y);
    ctx.closePath();
    ctx.stroke();
  }
  drawOmittedFrameQuads(ctx, mapRectifiedPointToPreview);
  const currentFrameQuad = getCurrentPreviewFrameQuad();
  if (currentFrameQuad) {
    // Draw the current frame in full rectified-sheet coordinates, remapped onto the preview canvas.
    ctx.strokeStyle = "rgb(0, 128, 0)";
    ctx.lineWidth = getPanelOverlayStrokeWidth(1);
    const tl = mapRectifiedPointToPreview(currentFrameQuad.tl);
    const tr = mapRectifiedPointToPreview(currentFrameQuad.tr);
    const br = mapRectifiedPointToPreview(currentFrameQuad.br);
    const bl = mapRectifiedPointToPreview(currentFrameQuad.bl);
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.stroke();
  }
  drawActiveEditedMarkerEdges(ctx, mapRectifiedPointToPreview);
  if (
    config.alignmentPipeline === "markerless" &&
    state.runtime.markerlessPhaseDebugVisible &&
    !state.preview.showRectifiedDiagnostic
  ) {
    drawMarkerlessPhaseDebugChart(
      ctx,
      state.geometry.alignmentInfo?.markerlessEstimate?.phaseDebugX || null,
      offsetX,
      offsetY,
      overlayScaleX,
      drawW,
      drawH,
      fullRectifiedWidth,
      fullRectifiedHeight,
    );
  }
  ctx.restore();
}

/**
 * Draw a temporary inset chart showing the left-to-right markerless phase-support metrics.
 *
 * The three plotted curves are the same normalized gutter-support terms used by the phase solver:
 * low darkness, low texture, and low variance. That means likely gutters appear as upward spikes.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{positions:number[], darkness:number[], texture:number[], variance:number[], gutter:number[]}|null} phaseDebugX
 * @param {number} imageOffsetX
 * @param {number} imageOffsetY
 * @param {number} imageScale
 * @param {number} imageDrawWidth
 * @param {number} imageDrawHeight
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @returns {void}
 */
function drawMarkerlessPhaseDebugChart(
  ctx,
  phaseDebugX,
  imageOffsetX,
  imageOffsetY,
  imageScale,
  imageDrawWidth,
  imageDrawHeight,
  imageWidth,
  imageHeight,
) {
  const amplitudeScale = 0.25;
  if (
    !phaseDebugX?.positions?.length ||
    !phaseDebugX?.darkness?.length ||
    !phaseDebugX?.texture?.length ||
    !phaseDebugX?.variance?.length ||
    !phaseDebugX?.gutter?.length
  ) return;
  const chartHeight = Math.min(180, Math.max(120, Math.round(imageDrawHeight * 0.28)));
  const chartBottom = imageOffsetY + imageDrawHeight;
  const chartTop = chartBottom - chartHeight;
  const plotX = imageOffsetX;
  const plotY = chartTop;
  const plotW = imageDrawWidth;
  const plotH = chartHeight;
  const curves = [
    { data: phaseDebugX.darkness, color: "#8B0000", label: "darkness", amplitudeScale },
    { data: phaseDebugX.texture, color: "#006400", label: "texture", amplitudeScale },
    { data: phaseDebugX.variance, color: "#0000CD", label: "variance", amplitudeScale },
    { data: normalizeDebugCurveForDisplay(phaseDebugX.gutter), color: "#000000", label: "product", amplitudeScale: 1 },
  ];

  ctx.save();
  ctx.beginPath();
  ctx.rect(imageOffsetX, imageOffsetY, imageDrawWidth, imageDrawHeight);
  ctx.clip();

  ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
  ctx.fillRect(plotX, plotY, plotW, plotH);

  ctx.strokeStyle = "rgba(32, 33, 36, 0.15)";
  ctx.beginPath();
  ctx.moveTo(plotX, plotY + plotH * 0.5);
  ctx.lineTo(plotX + plotW, plotY + plotH * 0.5);
  ctx.stroke();

  ctx.font = "11px sans-serif";
  ctx.textBaseline = "top";
  let legendX = plotX;
  for (const curve of curves) {
    ctx.fillStyle = curve.color;
    ctx.fillRect(legendX, plotY + 6, 10, 3);
    legendX += 14;
    ctx.fillText(curve.label, legendX, plotY + 1);
    legendX += ctx.measureText(curve.label).width + 14;
  }

  const positions = phaseDebugX.positions;
  for (const curve of curves) {
    const data = curve.data;
    ctx.strokeStyle = curve.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const rectifiedX = Math.max(0, Math.min(imageWidth, Number(positions[i]) || 0));
      const x = imageOffsetX + (rectifiedX * imageScale);
      const y = plotY + plotH - (Math.max(0, Number(data[i]) || 0) * plotH * curve.amplitudeScale);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Normalize one debug curve into 0..1 for chart display only.
 *
 * The combined gutter signal can use a different numeric range than the component terms, so the
 * overlay scales it independently to keep the black curve legible.
 *
 * @param {number[]} data
 * @returns {number[]}
 */
function normalizeDebugCurveForDisplay(data) {
  if (!Array.isArray(data) || data.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const value of data) {
    const numeric = Number(value) || 0;
    if (numeric < min) min = numeric;
    if (numeric > max) max = numeric;
  }
  const range = Math.max(1e-6, max - min);
  return data.map((value) => ((Number(value) || 0) - min) / range);
}

/**
 * Choose whether Panel 2 should show the full page warp or the cropped extraction-space sheet.
 *
 * A loaded settings file means the project already carries tuned detection settings, so the
 * extraction-space view is more useful. For first-time images without settings, the full page warp
 * exposes the frame-grid search area while the user adjusts Page & Grid Detection controls.
 *
 * @returns {boolean}
 */
function shouldShowFullPageRectifiedPreview() {
  return state.preview.rectifiedViewMode === "pre" && !!state.geometry.baseRectifiedPageCanvas;
}

/**
 * Return the canvas currently preferred for the Rectified Grid panel.
 *
 * Both source canvases are intentionally retained: callers can still render either the full page
 * warp or the cropped extraction-space sheet by passing that canvas to `renderRectifiedPreview`.
 *
 * @returns {HTMLCanvasElement | null}
 */
function getPreferredRectifiedPreviewCanvas() {
  if (shouldShowFullPageRectifiedPreview()) {
    return state.geometry.baseRectifiedPageCanvas;
  }
  return state.geometry.baseRectifiedCanvas;
}

/**
 * Keep the Rectified Grid Pre/Post radio state synchronized with the current display mode.
 *
 * @returns {void}
 */
function syncRectifiedViewToggleUi() {
  if (!dom.rectifiedViewPre || !dom.rectifiedViewPost) return;
  const canShowPre = !!state.geometry.baseRectifiedPageCanvas;
  if (!canShowPre && state.preview.rectifiedViewMode === "pre") {
    state.preview.rectifiedViewMode = "post";
  }
  const mode = shouldShowFullPageRectifiedPreview() ? "pre" : "post";
  dom.rectifiedViewPre.disabled = !canShowPre;
  dom.rectifiedViewPre.checked = mode === "pre";
  dom.rectifiedViewPost.checked = mode === "post";
}

/**
 * Switch Panel 2 between the full page warp and the cropped extraction-space rectified sheet.
 *
 * @param {"pre"|"post"} mode
 * @returns {void}
 */
function setRectifiedPreviewMode(mode) {
  state.preview.searchInsetPreviewForced = false;
  state.preview.searchInsetPreviewRestoreMode = null;
  state.preview.rectifiedViewMode = mode === "post" ? "post" : "pre";
  syncRectifiedViewToggleUi();
  if (state.geometry.baseRectifiedCanvas || state.geometry.baseRectifiedPageCanvas) {
    refreshAppearanceOutputs();
  }
}

/**
 * Temporarily switch Panel 2 to `Pre` while Grid Search Inset X/Y is being adjusted.
 *
 * @returns {void}
 */
function beginSearchInsetPreviewOverride() {
  if (!state.geometry.baseRectifiedPageCanvas) return;
  if (!state.preview.searchInsetPreviewForced) {
    state.preview.searchInsetPreviewRestoreMode = state.preview.rectifiedViewMode;
  }
  if (state.preview.rectifiedViewMode !== "pre") {
    state.preview.rectifiedViewMode = "pre";
    state.preview.searchInsetPreviewForced = true;
    syncRectifiedViewToggleUi();
    refreshAppearanceOutputs();
    return;
  }
  if (state.preview.searchInsetPreviewRestoreMode === "post") {
    state.preview.searchInsetPreviewForced = true;
  }
}

/**
 * Restore the user's prior Panel 2 view after Grid Search Inset X/Y interaction ends.
 *
 * @returns {void}
 */
function endSearchInsetPreviewOverride() {
  if (!state.preview.searchInsetPreviewForced) return;
  const restoreMode = state.preview.searchInsetPreviewRestoreMode;
  state.preview.searchInsetPreviewForced = false;
  state.preview.searchInsetPreviewRestoreMode = null;
  if (restoreMode !== "post") return;
  state.preview.rectifiedViewMode = "post";
  syncRectifiedViewToggleUi();
  if (state.geometry.baseRectifiedCanvas || state.geometry.baseRectifiedPageCanvas) {
    refreshAppearanceOutputs();
  }
}

/**
 * Resolve one marker to its refined/overridden rectified-sheet location, falling back to the
 * nominal lattice if that marker is unavailable.
 *
 * @param {object} extractionInfo
 * @param {number} col
 * @param {number} row
 * @returns {{x:number, y:number}}
 */
function resolveFrameMarkerPoint(extractionInfo, col, row) {
  const marker = extractionInfo?.markerLookup?.get(`${col},${row}`);
  if (marker) {
    return { x: marker.detectedX, y: marker.detectedY };
  }
  const bounds = extractionInfo.gridBounds;
  return {
    x: bounds.left + bounds.width * (col / extractionInfo.cols),
    y: bounds.top + bounds.height * (row / extractionInfo.rows),
  };
}

/**
 * Resolve the quadrilateral for one extracted frame using the current marker positions.
 *
 * @param {object} extractionInfo
 * @param {number} col
 * @param {number} row
 * @returns {{tl:{x:number,y:number}, tr:{x:number,y:number}, br:{x:number,y:number}, bl:{x:number,y:number}}}
 */
function resolveFrameQuadForPreview(extractionInfo, col, row) {
  return {
    tl: resolveFrameMarkerPoint(extractionInfo, col, row),
    tr: resolveFrameMarkerPoint(extractionInfo, col + 1, row),
    br: resolveFrameMarkerPoint(extractionInfo, col + 1, row + 1),
    bl: resolveFrameMarkerPoint(extractionInfo, col, row + 1),
  };
}

/**
 * Return the frame quad corresponding to the frame currently shown in Animation Preview.
 *
 * @returns {{tl:{x:number,y:number}, tr:{x:number,y:number}, br:{x:number,y:number}, bl:{x:number,y:number}} | null}
 */
function getPreviewFrameQuadForSourceIndex(sourceIndex) {
  const alignmentInfo = state.geometry.alignmentInfo;
  if (!alignmentInfo || state.geometry.frameCount <= 0) return null;
  const cols = alignmentInfo.cols;
  const col = sourceIndex % cols;
  const row = Math.floor(sourceIndex / cols);
  if (row < 0 || row >= alignmentInfo.rows) return null;
  const extractionInfo =
    // Per-frame uses the same corner-cross lattice as markerless, so resolve preview frame quads
    // through the markerless extraction builder for both non-marker pipelines.
    readConfig().alignmentPipeline !== "markers"
      ? buildMarkerlessExtractionInfoForFrame(alignmentInfo, col, row)
      : alignmentInfo;
  const quad = resolveFrameQuadForPreview(extractionInfo, col, row);
  const phaseOffset = getMarkerlessPhaseSourceOffset(readConfig(), alignmentInfo);
  const driftOffset = getMarkerlessVerticalDriftSourceOffset(readConfig(), alignmentInfo, sourceIndex);
  const stabilizationOffset = getFrameStabilizationSourceOffset(sourceIndex);
  const offset = {
    x: phaseOffset.x + stabilizationOffset.x + driftOffset.x,
    y: phaseOffset.y + stabilizationOffset.y + driftOffset.y,
  };
  if (Math.abs(offset.x) < 1e-6 && Math.abs(offset.y) < 1e-6) {
    return quad;
  }
  return {
    tl: { x: quad.tl.x + offset.x, y: quad.tl.y + offset.y },
    tr: { x: quad.tr.x + offset.x, y: quad.tr.y + offset.y },
    br: { x: quad.br.x + offset.x, y: quad.br.y + offset.y },
    bl: { x: quad.bl.x + offset.x, y: quad.bl.y + offset.y },
  };
}

/**
 * Return the frame quad corresponding to the frame currently shown in Animation Preview.
 *
 * @returns {{tl:{x:number,y:number}, tr:{x:number,y:number}, br:{x:number,y:number}, bl:{x:number,y:number}} | null}
 */
function getCurrentPreviewFrameQuad() {
  return getPreviewFrameQuadForSourceIndex(getCurrentDisplayedFrameSourceIndex());
}

/**
 * Draw omitted source cells on the Rectified Grid so users can see which highest-indexed frames
 * have been excluded from playback/export by Number of Frames to Export.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {(point:{x:number,y:number}) => {x:number,y:number}} mapRectifiedPointToPreview
 * @returns {void}
 */
function drawOmittedFrameQuads(ctx, mapRectifiedPointToPreview) {
  const totalFrameCount = Math.max(0, state.geometry.frameCount || 0);
  const includedFrameCount = getIncludedSourceFrameCount();
  if (!state.geometry.alignmentInfo || includedFrameCount >= totalFrameCount) return;
  ctx.save();
  // Tint omitted cells before drawing the red outline/slash so exclusion remains legible on busy art.
  ctx.fillStyle = "rgba(204, 204, 204, 0.4)";
  ctx.strokeStyle = "rgb(200, 0, 0)";
  ctx.lineWidth = getPanelOverlayStrokeWidth(1);
  for (let sourceIndex = includedFrameCount; sourceIndex < totalFrameCount; sourceIndex += 1) {
    const quad = getPreviewFrameQuadForSourceIndex(sourceIndex);
    if (!quad) continue;
    const tl = mapRectifiedPointToPreview(quad.tl);
    const tr = mapRectifiedPointToPreview(quad.tr);
    const br = mapRectifiedPointToPreview(quad.br);
    const bl = mapRectifiedPointToPreview(quad.bl);
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tr.x, tr.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Resolve one currently displayed alignment point for Rectified Grid overlays.
 *
 * Marker mode reads directly from the live alignment lattice, which already includes in-place
 * override edits. Markerless mode resolves the current displayed corner position after phase,
 * stabilization, and any stored post-stabilization manual nudge.
 *
 * @param {object} alignmentInfo
 * @param {number} col
 * @param {number} row
 * @returns {{x:number,y:number}}
 */
function resolveDisplayedAlignmentPoint(alignmentInfo, col, row) {
  const key = getMarkerKey(col, row);
  // Per-frame shares the markerless corner-display model (phase + stabilization + manual nudge).
  if (readConfig().alignmentPipeline !== "markers") {
    const sourceMarker = alignmentInfo?.markerLookup?.get(key);
    if (sourceMarker) {
      const displayed = getMarkerlessDisplayedCorner(sourceMarker, col, row, alignmentInfo);
      return { x: displayed.detectedX, y: displayed.detectedY };
    }
  }
  return resolveFrameMarkerPoint(alignmentInfo, col, row);
}

/**
 * Draw the frame-boundary segments incident to the marker/corner currently being edited.
 *
 * Only the 2-4 connected lattice edges are drawn so the user can see which local frame boundaries
 * are moving while dragging an override.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {(point:{x:number,y:number}) => {x:number,y:number}} mapRectifiedPointToPreview
 * @returns {void}
 */
function drawActiveEditedMarkerEdges(ctx, mapRectifiedPointToPreview) {
  const activeMarker = state.preview.activeEditedMarker;
  const alignmentInfo = state.geometry.alignmentInfo;
  if (!activeMarker || !alignmentInfo) return;

  const { col, row } = activeMarker;
  const segments = [];
  if (col > 0) segments.push([{ col: col - 1, row }, { col, row }]);
  if (col < alignmentInfo.cols) segments.push([{ col, row }, { col: col + 1, row }]);
  if (row > 0) segments.push([{ col, row: row - 1 }, { col, row }]);
  if (row < alignmentInfo.rows) segments.push([{ col, row }, { col, row: row + 1 }]);
  if (!segments.length) return;

  ctx.save();
  ctx.strokeStyle = "rgb(0, 128, 0)";
  ctx.lineWidth = getPanelOverlayStrokeWidth(1);
  for (const [startMarker, endMarker] of segments) {
    const start = resolveDisplayedAlignmentPoint(alignmentInfo, startMarker.col, startMarker.row);
    const end = resolveDisplayedAlignmentPoint(alignmentInfo, endMarker.col, endMarker.row);
    const startPreview = mapRectifiedPointToPreview(start);
    const endPreview = mapRectifiedPointToPreview(end);
    ctx.beginPath();
    ctx.moveTo(startPreview.x, startPreview.y);
    ctx.lineTo(endPreview.x, endPreview.y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Map one point from extraction-rectified coordinates back into the full page-preview warp.
 *
 * @param {{x:number,y:number}} point
 * @returns {{x:number,y:number}}
 */
function mapRectifiedPointToPagePreview(point) {
  const alignmentInfo = state.geometry.alignmentInfo;
  const previewQuad = state.geometry.pagePreviewGridQuad;
  if (!alignmentInfo || !previewQuad || typeof cv === "undefined") {
    return { x: point.x, y: point.y };
  }
  const bounds = state.geometry.pagePreviewGridBounds || alignmentInfo.gridBounds;
  const srcTl = { x: bounds.left, y: bounds.top };
  const srcTr = { x: bounds.left + bounds.width, y: bounds.top };
  const srcBr = { x: bounds.left + bounds.width, y: bounds.top + bounds.height };
  const srcBl = { x: bounds.left, y: bounds.top + bounds.height };
  const srcCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
    srcTl.x, srcTl.y,
    srcTr.x, srcTr.y,
    srcBr.x, srcBr.y,
    srcBl.x, srcBl.y,
  ]);
  const dstCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
    previewQuad.tl.x, previewQuad.tl.y,
    previewQuad.tr.x, previewQuad.tr.y,
    previewQuad.br.x, previewQuad.br.y,
    previewQuad.bl.x, previewQuad.bl.y,
  ]);
  const srcPoint = cv.matFromArray(1, 1, cv.CV_32FC2, [point.x, point.y]);
  const dstPoint = new cv.Mat();
  const transform = cv.getPerspectiveTransform(srcCorners, dstCorners);
  try {
    cv.perspectiveTransform(srcPoint, dstPoint, transform);
    return {
      x: dstPoint.data32F[0],
      y: dstPoint.data32F[1],
    };
  } finally {
    srcCorners.delete();
    dstCorners.delete();
    srcPoint.delete();
    dstPoint.delete();
    transform.delete();
  }
}

/**
 * Return the current preview frame quad expressed in the full page-preview coordinate system.
 *
 * @returns {{tl:{x:number,y:number}, tr:{x:number,y:number}, br:{x:number,y:number}, bl:{x:number,y:number}} | null}
 */
function getCurrentPreviewFrameQuadInPagePreview() {
  const quad = getCurrentPreviewFrameQuad();
  if (!quad) return null;
  return {
    tl: mapRectifiedPointToPagePreview(quad.tl),
    tr: mapRectifiedPointToPagePreview(quad.tr),
    br: mapRectifiedPointToPagePreview(quad.br),
    bl: mapRectifiedPointToPagePreview(quad.bl),
  };
}

/**
 * Build the cross-kernel convolution diagnostic image for the current rectified-page preview.
 *
 * @param {HTMLCanvasElement} sourceCanvas
 * @returns {HTMLCanvasElement}
 */
function getRectifiedConvolutionCanvas(sourceCanvas) {
  if (
    state.preview.rectifiedDiagnosticDirty ||
    state.preview.rectifiedDiagnosticSourceCanvas !== sourceCanvas
  ) {
    buildCrossConvolutionCanvas(sourceCanvas, state.preview.rectifiedDiagnosticCanvas);
    state.preview.rectifiedDiagnosticSourceCanvas = sourceCanvas;
    state.preview.rectifiedDiagnosticDirty = false;
  }
  return state.preview.rectifiedDiagnosticCanvas;
}

/**
 * Invalidate all appearance-adjusted frame caches while keeping the base geometry/debug previews
 * intact. The Rectified Grid no longer depends on Appearance, so it must keep its canvas handle
 * in order for the animated frame quad to continue updating during preview playback.
 *
 * @returns {void}
 */
function invalidateAppearanceCache() {
  cancelPreviewFrameWarmup();
  state.frames.adjustedCache.clear();
  state.frames.adjustedOutputEpoch.clear();
}

/**
 * Release the cached rectified-sheet OpenCV mat used for lazy frame extraction.
 *
 * @returns {void}
 */
function releaseRectifiedCvCache() {
  if (state.geometry.baseRectifiedMat) {
    state.geometry.baseRectifiedMat.delete();
    state.geometry.baseRectifiedMat = null;
  }
  if (state.geometry.baseRectifiedGrayMat) {
    state.geometry.baseRectifiedGrayMat.delete();
    state.geometry.baseRectifiedGrayMat = null;
  }
}

/**
 * Free heavy reusable caches before starting a new geometry/CV pass.
 *
 * This keeps the currently painted UI visible, but drops old extracted-frame canvases, solved
 * stabilization data, and rectified Mats so large reprocesses do not have to coexist with the
 * previous run's biggest buffers.
 *
 * @returns {void}
 */
function trimCachesBeforeReprocess() {
  releaseRectifiedCvCache();
  state.preview.rectifiedDiagnosticSourceCanvas = null;
  state.preview.rectifiedDiagnosticDirty = true;
  state.preview.postRotationPreviewCanvas = null;
  state.preview.postRotationPreviewSourceCanvas = null;
  state.preview.postRotationPreviewDeg = 0;
  releaseRectifiedFullResUrl();
  state.preview.rectifiedFullResBuildId += 1;
  state.frames.base = [];
  state.frames.baseOutputEpoch = [];
  state.frames.stabilizedCache.clear();
  state.frames.stabilizedOutputEpoch.clear();
  state.frames.phaseAdjustedCache.clear();
  state.frames.stabilizationMatchData = null;
  state.frames.stabilizationPairwise = null;
  state.frames.stabilizationAverageReference = null;
  state.frames.stabilizationOffsets = null;
  state.frames.adjustedCache.clear();
  state.frames.adjustedOutputEpoch.clear();
  trimInactivePerFrameRectifiedCaches();
  syncRectifiedSheetHeadingLink();
}

/**
 * Free per-image rectified Mat caches for every image that is NOT the active one, before a
 * reprocess. In per-frame mode each uploaded image can hold its own cached rectified warp; only the
 * active image's cache is kept warm between reprocesses. The composite `baseRectifiedMat` (the one
 * large Mat that must stay live) is owned by `state.geometry`, not by the per-image entries, so it is
 * never touched here.
 *
 * No-op for markers/markerless modes: those flows keep at most a single entry in
 * `state.source.images[]`, so the loop either skips the lone active entry or runs zero times.
 *
 * @returns {void}
 */
function trimInactivePerFrameRectifiedCaches() {
  const images = state.source.images;
  if (!Array.isArray(images) || images.length <= 1) return;
  const activeIndex = state.source.activeImageIndex;
  for (let i = 0; i < images.length; i++) {
    if (i === activeIndex) continue;
    releaseEntryRectifiedCache(images[i]);
  }
}

/**
 * Invalidate the post-extraction stabilization solve and any derived frame caches.
 *
 * @returns {void}
 */
function invalidateStabilizationCache() {
  cancelStabilizationMeasurement();
  state.frames.stabilizedCache.clear();
  state.frames.stabilizedOutputEpoch.clear();
  state.frames.phaseAdjustedCache.clear();
  state.frames.stabilizationMatchData = null;
  state.frames.stabilizationPairwise = null;
  state.frames.stabilizationAverageReference = null;
  state.frames.stabilizationOffsets = null;
  state.frames.adjustedCache.clear();
  state.frames.adjustedOutputEpoch.clear();
  refreshStatusDisplay();
}

/**
 * Invalidate stabilized/adjusted frame outputs while keeping the solved pairwise offsets cached.
 *
 * This is used when stabilization is toggled on or off because the solve does not change, only
 * whether the solved offsets are applied.
 *
 * @returns {void}
 */
function invalidateStabilizedOutputCaches() {
  state.frames.stabilizedCache.clear();
  state.frames.stabilizedOutputEpoch.clear();
  state.frames.phaseAdjustedCache.clear();
  state.frames.adjustedCache.clear();
  state.frames.adjustedOutputEpoch.clear();
}

/**
 * Run one cache mutation while restoring the current stabilization solve afterward.
 *
 * Several UI controls need the old "invalidate all frame outputs" behavior to fully refresh the
 * animation, but they should not force the expensive stabilization matcher to restart.
 *
 * @param {() => void} mutation
 * @returns {void}
 */
function withPreservedStabilizationCaches(mutation) {
  const savedMatchData = state.frames.stabilizationMatchData;
  const savedPairwise = state.frames.stabilizationPairwise;
  const savedAverageReference = state.frames.stabilizationAverageReference;
  const savedOffsets = state.frames.stabilizationOffsets;
  mutation();
  state.frames.stabilizationMatchData = savedMatchData;
  state.frames.stabilizationPairwise = savedPairwise;
  state.frames.stabilizationAverageReference = savedAverageReference;
  state.frames.stabilizationOffsets = savedOffsets;
}

/**
 * Advance the output-cache epoch so lazily accessed frames know they must be regenerated.
 *
 * @returns {void}
 */
function bumpFrameOutputEpoch() {
  state.frames.outputEpoch += 1;
}

/**
 * Clear extracted/stabilized/adjusted frame-output caches without touching stabilization inputs.
 *
 * @returns {void}
 */
function clearFrameOutputCachesOnly() {
  cancelPreviewFrameWarmup();
  state.frames.base = new Array(state.geometry.frameCount);
  state.frames.baseOutputEpoch = new Array(state.geometry.frameCount);
  state.frames.stabilizedCache.clear();
  state.frames.stabilizedOutputEpoch.clear();
  state.frames.phaseAdjustedCache.clear();
  state.frames.adjustedCache.clear();
  state.frames.adjustedOutputEpoch.clear();
}

/**
 * Invalidate extracted frame outputs while preserving any cached stabilization measurements.
 *
 * @returns {void}
 */
function invalidateFrameOutputCaches() {
  withPreservedStabilizationCaches(() => {
    clearFrameOutputCachesOnly();
  });
}

/**
 * Invalidate only the post-stabilization phase-adjusted outputs.
 *
 * Markerless phase offsets are now applied after stabilization, so changing them should not force
 * frame extraction or stabilization recomputation.
 *
 * @returns {void}
 */
function invalidatePhaseAdjustedOutputCaches() {
  cancelPreviewFrameWarmup();
  state.frames.phaseAdjustedCache.clear();
  state.frames.adjustedCache.clear();
  state.frames.adjustedOutputEpoch.clear();
}

/**
 * Rebuild every extracted/output frame while preserving any cached stabilization measurements.
 *
 * This is used by controls such as phase offsets and crop/output geometry, where users expect the
 * full animation to reflect the committed change immediately after release.
 *
 * @returns {void}
 */
function rebuildAllFrameOutputCaches() {
  invalidateFrameOutputCaches();
  scheduleCurrentPreviewFrameWarmup();
}

/**
 * Rebuild every phase-adjusted/output frame while preserving extraction and stabilization caches.
 *
 * @returns {void}
 */
function rebuildAllPhaseAdjustedOutputCaches() {
  invalidatePhaseAdjustedOutputCaches();
  scheduleCurrentPreviewFrameWarmup();
}

/**
 * Invalidate only the solved stabilization offsets plus derived frame outputs, while keeping the
 * measured pairwise shifts cached. This is used when lambda changes because the solve changes but
 * the underlying adjacent-frame measurements do not.
 *
 * @returns {void}
 */
function invalidateStabilizationOffsetsCache() {
  cancelPreviewFrameWarmup();
  state.frames.stabilizationOffsets = null;
  state.frames.stabilizedCache.clear();
  state.frames.stabilizedOutputEpoch.clear();
  state.frames.phaseAdjustedCache.clear();
  state.frames.adjustedCache.clear();
  state.frames.adjustedOutputEpoch.clear();
}

/**
 * Invalidate lazily extracted base frames and any adjusted-frame cache derived from them.
 *
 * @returns {void}
 */
function invalidateFrameCaches() {
  cancelStabilizationMeasurement();
  cancelPreviewFrameWarmup();
  state.frames.outputEpoch += 1;
  clearFrameOutputCachesOnly();
  state.frames.stabilizationMatchData = null;
  state.frames.stabilizationPairwise = null;
  state.frames.stabilizationAverageReference = null;
  state.frames.stabilizationOffsets = null;
  refreshStatusDisplay();
}

/**
 * Invalidate only the currently displayed frame so markerless phase dragging stays responsive.
 *
 * The current stabilization solve is kept during drag. Full frame/stabilization invalidation still
 * happens on slider release so playback and export catch up across the whole sequence.
 *
 * @returns {void}
 */
function invalidateCurrentPreviewFrameCaches() {
  const frameCount = state.geometry.frameCount;
  if (frameCount <= 0) return;
  const index = getCurrentDisplayedFrameSourceIndex();
  if (index < 0 || index >= frameCount) return;
  state.frames.base[index] = undefined;
  state.frames.baseOutputEpoch[index] = undefined;
  state.frames.stabilizedCache.delete(index);
  state.frames.stabilizedOutputEpoch.delete(index);
  state.frames.phaseAdjustedCache.delete(index);
  state.frames.adjustedCache.delete(index);
  state.frames.adjustedOutputEpoch.delete(index);
}

/**
 * Invalidate only the currently displayed stabilized/adjusted frame so stabilization preview
 * updates can feel responsive without recomputing the global shift solve.
 *
 * @returns {void}
 */
function invalidateCurrentPreviewStabilizationCaches() {
  const frameCount = state.geometry.frameCount;
  if (frameCount <= 0) return;
  const index = getCurrentDisplayedFrameSourceIndex();
  if (index < 0 || index >= frameCount) return;
  state.frames.stabilizedCache.delete(index);
  state.frames.phaseAdjustedCache.delete(index);
  state.frames.adjustedCache.delete(index);
}

/**
 * Invalidate only the currently displayed phase-adjusted output.
 *
 * @returns {void}
 */
function invalidateCurrentPreviewPhaseAdjustedCaches() {
  const frameCount = state.geometry.frameCount;
  if (frameCount <= 0) return;
  const index = getCurrentDisplayedFrameSourceIndex();
  if (index < 0 || index >= frameCount) return;
  state.frames.phaseAdjustedCache.delete(index);
  state.frames.adjustedCache.delete(index);
}

/**
 * Invalidate only the currently displayed frame if it is one of the cells touched by an edited
 * corner marker. This keeps markerless corner dragging responsive by avoiding a full
 * stabilization/cache rebuild on every pointermove.
 *
 * @param {number} markerCol
 * @param {number} markerRow
 * @returns {void}
 */
function invalidateCurrentPreviewFrameForMarker(markerCol, markerRow) {
  const frameCount = state.geometry.frameCount;
  if (frameCount <= 0) return;
  const index = getCurrentDisplayedFrameSourceIndex();
  if (index < 0 || index >= frameCount) return;
  const affected = getAffectedFrameIndicesForMarker(markerCol, markerRow);
  if (!affected.includes(index)) return;
  state.frames.base[index] = undefined;
  state.frames.stabilizedCache.delete(index);
  state.frames.phaseAdjustedCache.delete(index);
  state.frames.adjustedCache.delete(index);
}

/**
 * Return the extracted frame indices affected by one alignment marker.
 *
 * Marker `(c, r)` can influence up to four neighboring frame cells:
 * `(c-1, r-1)`, `(c, r-1)`, `(c-1, r)`, `(c, r)`.
 *
 * @param {number} markerCol
 * @param {number} markerRow
 * @returns {number[]}
 */
function getAffectedFrameIndicesForMarker(markerCol, markerRow) {
  const alignmentInfo = state.geometry.alignmentInfo;
  if (!alignmentInfo) return [];
  const indices = [];
  for (let row = markerRow - 1; row <= markerRow; row++) {
    for (let col = markerCol - 1; col <= markerCol; col++) {
      if (col < 0 || row < 0 || col >= alignmentInfo.cols || row >= alignmentInfo.rows) continue;
      indices.push((row * alignmentInfo.cols) + col);
    }
  }
  return indices;
}

/**
 * Invalidate only the extracted/adjusted frames touched by one edited marker.
 *
 * This keeps interactive marker dragging responsive by avoiding unnecessary re-extraction of
 * frames that do not depend on the moved marker. Stabilization is the exception: once enabled with
 * nonzero strength, a changed source frame can alter the solved offset field, so callers must treat
 * a null return value as a whole-sequence dependency.
 *
 * @param {number} markerCol
 * @param {number} markerRow
 * @returns {number[] | null} affected frame indices, or null when stabilization makes the
 * whole output sequence dependent on the edit
 */
function invalidateFramesForMarker(markerCol, markerRow) {
  const affected = getAffectedFrameIndicesForMarker(markerCol, markerRow);
  const config = readConfig();
  const stabilizationCanMoveUneditedFrames =
    config.stabilizationEnabled &&
    (config.stabilizationStrengthPct || 0) > 0;
  if (stabilizationCanMoveUneditedFrames) {
    state.frames.stabilizedCache.clear();
    state.frames.phaseAdjustedCache.clear();
    state.frames.stabilizationMatchData = null;
    state.frames.stabilizationAverageReference = null;
    state.frames.stabilizationOffsets = null;
    state.frames.stabilizationPairwise = null;
    state.frames.adjustedCache.clear();
    state.frames.adjustedOutputEpoch.clear();
  }
  for (const index of affected) {
    state.frames.base[index] = undefined;
    state.frames.baseOutputEpoch[index] = undefined;
    state.frames.stabilizedCache.delete(index);
    state.frames.stabilizedOutputEpoch.delete(index);
    state.frames.phaseAdjustedCache.delete(index);
    state.frames.adjustedCache.delete(index);
    state.frames.adjustedOutputEpoch.delete(index);
  }
  return stabilizationCanMoveUneditedFrames ? null : affected;
}

/**
 * Invalidate only the frame outputs touched by one markerless post-stabilization corner nudge.
 *
 * The stabilization solve stays valid because markerless corner overrides are applied after that
 * solve, at extraction/display time only.
 *
 * @param {number} markerCol
 * @param {number} markerRow
 * @returns {void}
 */
function invalidateMarkerlessNudgedFramesForMarker(markerCol, markerRow) {
  for (const index of getAffectedFrameIndicesForMarker(markerCol, markerRow)) {
    state.frames.base[index] = undefined;
    state.frames.stabilizedCache.delete(index);
    state.frames.phaseAdjustedCache.delete(index);
    state.frames.adjustedCache.delete(index);
  }
}

/**
 * Refresh the rectified-sheet preview from the unadjusted base page rectification.
 *
 * The Rectified Grid panel is intended as a geometry/debug view, so Appearance controls should
 * not recolor it even when those same controls affect the live animation preview and exports.
 *
 * @returns {void}
 */
function refreshAppearanceOutputs() {
  const rectifiedDisplayCanvas = getPreferredRectifiedPreviewCanvas();
  if (!rectifiedDisplayCanvas) return;
  syncRectifiedViewToggleUi();
  state.preview.rectifiedCanvas = rectifiedDisplayCanvas;
  state.preview.rectifiedDiagnosticSourceCanvas = null;
  state.preview.rectifiedDiagnosticDirty = true;
  primeRectifiedDragAsset(state.preview.rectifiedCanvas);
  syncRectifiedSheetHeadingLink();
  renderRectifiedPreview(state.preview.rectifiedCanvas);
}

/**
 * Extract one frame from the cached rectified sheet, optionally shifting the source quad before
 * post-crop output transforms are applied. Stabilization uses this path so corrected pixels can
 * come from neighboring sheet content instead of duplicating the already-extracted frame edges.
 *
 * Markerless extraction stacks several source-space adjustments in a fixed order:
 * 1. autocorrelation baseline from the pipeline
 * 2. manual phase offsets (`Horizontal/Vertical Phase Offset`)
 * 3. optional animation-wide vertical drift compensation
 * 4. optional per-frame stabilization translation
 * 5. optional post-stabilization per-corner nudges from Frame Corners overrides
 *
 * Keeping these layers explicit is important because only some of them are allowed to feed back
 * into the stabilization solve. In particular, manual Frame Corners overrides are intentionally
 * post-stabilization nudges in markerless mode.
 *
 * @param {number} index
 * @param {{x:number,y:number}} [sourceOffset={x:0,y:0}]
 * @returns {HTMLCanvasElement | null}
 */
function extractProcessedFrameCanvas(index, sourceOffset = { x: 0, y: 0 }, includeMarkerlessNudges = true, includeMarkerlessDriftCompensation = true) {
  return timeProfiled("extractProcessedFrameCanvas", () => {
    const extractionContext = getFrameExtractionContext(index, includeMarkerlessNudges);
    if (!extractionContext) return null;
    const { config, col, row, alignmentInfo, rectifiedMat } = extractionContext;
    const automaticOffset = getAutomaticMarkerlessSourceOffset(
      config,
      alignmentInfo,
      index,
      includeMarkerlessDriftCompensation
    );
    const frame = extractSingleFrameToCanvas(
      rectifiedMat,
      alignmentInfo,
      col,
      row,
      config.crop,
      getCvInterpolationFlag(config.exportOptions.resampling),
      combineSourceOffsets(automaticOffset, sourceOffset)
    );
    const transformedFrame = transformOutputCanvas(frame, config.postCropGeometry);
    const interactiveOutputSize = getInteractiveOutputSize(
      config.exportOptions.outputWidthPx,
      config.exportOptions.outputHeightPx,
    );
    return scaleOutputCanvas(
      transformedFrame,
      interactiveOutputSize.width,
      interactiveOutputSize.height,
      config.exportOptions.resampling
    );
  });
}

/**
 * Lazily extract one unadjusted animation frame from the cached rectified sheet.
 *
 * @param {number} index
 * @returns {HTMLCanvasElement | null}
 */
function getBaseFrameCanvas(index) {
  const cached = state.frames.base[index];
  if (cached && state.frames.baseOutputEpoch[index] === state.frames.outputEpoch) return cached;
  // Extraction stays lazy: pull just this frame from the rectified sheet, then apply post-crop
  // output scaling without forcing the whole animation to be rebuilt.
  const scaledFrame = extractProcessedFrameCanvas(index);
  state.frames.base[index] = scaledFrame;
  state.frames.baseOutputEpoch[index] = state.frames.outputEpoch;
  return scaledFrame;
}

/**
 * Extract one frame for the stabilization solver, explicitly excluding markerless post-stabilization
 * corner nudges, phase offsets, drift compensation, crop, and output scaling so the solve operates
 * on a stable neutral frame representation.
 *
 * @param {number} index
 * @returns {HTMLCanvasElement | null}
 */
function getStabilizationSourceFrameCanvas(index) {
  const extractionContext = getFrameExtractionContext(index, false);
  if (!extractionContext) return null;
  const { col, row, alignmentInfo, rectifiedMat } = extractionContext;
  return extractSingleFrameToCanvas(
    rectifiedMat,
    alignmentInfo,
    col,
    row,
    { left: 0, right: 0, top: 0, bottom: 0 },
    getCvInterpolationFlag("linear"),
    { x: 0, y: 0 }
  );
}

/**
 * Ensure the base rectified-sheet OpenCV mat exists.
 *
 * @returns {cv.Mat | null}
 */
function ensureBaseRectifiedMat() {
  if (state.geometry.baseRectifiedMat) return state.geometry.baseRectifiedMat;
  if (!state.geometry.baseRectifiedCanvas) return null;
  if (!state.geometry.baseRectifiedMat) {
    const rectifiedRgba = cv.imread(state.geometry.baseRectifiedCanvas);
    state.geometry.baseRectifiedMat = new cv.Mat();
    cv.cvtColor(rectifiedRgba, state.geometry.baseRectifiedMat, cv.COLOR_RGBA2BGR);
    rectifiedRgba.delete();
  }
  return state.geometry.baseRectifiedMat;
}

/**
 * Resolve the per-frame grid coordinates used by extraction.
 *
 * @param {number} index
 * @param {object} alignmentInfo
 * @returns {{col:number,row:number}}
 */
function getFrameGridCoords(index, alignmentInfo) {
  const cols = alignmentInfo.cols;
  return {
    col: index % cols,
    row: Math.floor(index / cols),
  };
}

/**
 * Return the alignment lattice view used for one extracted frame.
 *
 * Markerless manual overrides are applied by swapping in a lightweight frame-specific view of the
 * four surrounding corners. Marker mode continues to use the shared alignment lattice.
 *
 * @param {ReturnType<typeof readConfig>} config
 * @param {object} alignmentInfo
 * @param {number} col
 * @param {number} row
 * @param {boolean} includeMarkerlessNudges
 * @returns {object}
 */
function getFrameExtractionAlignmentInfo(config, alignmentInfo, col, row, includeMarkerlessNudges) {
  // Per-frame extracts from the same corner-cross lattice as markerless, so both non-marker
  // pipelines resolve frame quads via the markerless extraction builder (phase nudges are 0 in
  // per-frame, so this only contributes stabilization/drift/manual-nudge offsets there).
  if (config.alignmentPipeline !== "markers" && includeMarkerlessNudges) {
    return buildMarkerlessExtractionInfoForFrame(alignmentInfo, col, row);
  }
  return alignmentInfo;
}

/**
 * Gather the static extraction context for one frame.
 *
 * @param {number} index
 * @param {boolean} includeMarkerlessNudges
 * @returns {{config: ReturnType<typeof readConfig>, col:number, row:number, alignmentInfo:object, rectifiedMat:cv.Mat} | null}
 */
function getFrameExtractionContext(index, includeMarkerlessNudges) {
  const alignmentInfo = state.geometry.alignmentInfo;
  const rectifiedMat = ensureBaseRectifiedMat();
  if (!alignmentInfo || !rectifiedMat) return null;
  const config = readConfig();
  const { col, row } = getFrameGridCoords(index, alignmentInfo);
  return {
    config,
    col,
    row,
    alignmentInfo: getFrameExtractionAlignmentInfo(config, alignmentInfo, col, row, includeMarkerlessNudges),
    rectifiedMat,
  };
}

/**
 * Collect the frame canvases used by the stabilization matcher.
 *
 * @returns {HTMLCanvasElement[] | null}
 */
function collectStabilizationSourceFrames() {
  const frameCount = state.geometry.frameCount;
  if (frameCount <= 1) return null;
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const frame = getStabilizationSourceFrameCanvas(i);
    if (!frame) return null;
    frames.push(frame);
  }
  return frames;
}

/**
 * Build or reuse sampled grayscale match data for every pre-stabilization frame.
 *
 * Both stabilization methods use the same sampled stabilization matcher, so this shared cache
 * avoids rebuilding the reduced luma representation separately for pairwise and average-reference
 * experiments.
 *
 * @returns {{data:Float32Array,weights:Float32Array,width:number,height:number,scaleX:number,scaleY:number}[] | null}
 */
function getStabilizationMatchDataFrames() {
  return timeProfiled("getStabilizationMatchDataFrames", () => {
    const frameCount = state.geometry.frameCount;
    if (frameCount <= 1) return null;
    if (state.frames.stabilizationMatchData?.length === frameCount) {
      return state.frames.stabilizationMatchData;
    }
    const frames = collectStabilizationSourceFrames();
    if (!frames) return null;
    const matchData = frames.map((frame) => getFrameMatchData(frame));
    state.frames.stabilizationMatchData = matchData;
    return matchData;
  });
}

/**
 * Build one weighted stabilization edge between two frame indices.
 *
 * @param {Array<HTMLCanvasElement | {data:Float32Array,weights:Float32Array,width:number,height:number,scaleX:number,scaleY:number}>} frames
 * @param {number} from
 * @param {number} to
 * @param {"horizontal"|"rowBreak"|"vertical"|"seam"} kind
 * @returns {{from:number,to:number,dx:number,dy:number,kind:string,weight:number} | null}
 */
function buildStabilizationEdge(frames, from, to, kind) {
  if (from < 0 || to < 0 || from >= frames.length || to >= frames.length) return null;
  const shift = estimateLoopPairShift(frames[from], frames[to]);
  const edge = {
    from,
    to,
    dx: shift.dx,
    dy: shift.dy,
    kind,
  };
  edge.weight = getStabilizationEdgeWeight({
    ...edge,
    dx: shift.dxSample,
    dy: shift.dySample,
  });
  return edge;
}

/**
 * Append all within-row horizontal stabilization edge descriptors.
 *
 * @param {{from:number,to:number,kind:"horizontal"|"rowBreak"|"vertical"|"seam"}[]} edges
 * @param {number} cols
 * @param {number} rows
 * @returns {void}
 */
function appendHorizontalStabilizationEdgeDescriptors(edges, cols, rows) {
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const from = row * cols + col;
      const to = from + 1;
      edges.push({ from, to, kind: "horizontal" });
    }
  }
}

/**
 * Append end-of-row discontinuity stabilization edge descriptors.
 *
 * @param {{from:number,to:number,kind:"horizontal"|"rowBreak"|"vertical"|"seam"}[]} edges
 * @param {number} cols
 * @param {number} rows
 * @returns {void}
 */
function appendRowBreakStabilizationEdgeDescriptors(edges, cols, rows) {
  for (let row = 0; row < rows - 1; row++) {
    const from = (row * cols) + (cols - 1);
    const to = from + 1;
    edges.push({ from, to, kind: "rowBreak" });
  }
}

/**
 * Append vertical stabilization edge descriptors between neighboring sheet rows.
 *
 * @param {{from:number,to:number,kind:"horizontal"|"rowBreak"|"vertical"|"seam"}[]} edges
 * @param {number} cols
 * @param {number} rows
 * @returns {void}
 */
function appendVerticalStabilizationEdgeDescriptors(edges, cols, rows) {
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols; col++) {
      const from = row * cols + col;
      const to = (row + 1) * cols + col;
      edges.push({ from, to, kind: "vertical" });
    }
  }
}

/**
 * Append the weak loop-seam stabilization edge descriptor from the last frame back to the first.
 *
 * @param {{from:number,to:number,kind:"horizontal"|"rowBreak"|"vertical"|"seam"}[]} edges
 * @param {number} frameCount
 * @returns {void}
 */
function appendSeamStabilizationEdgeDescriptor(edges, frameCount) {
  edges.push({ from: frameCount - 1, to: 0, kind: "seam" });
}

/**
 * Build the full list of sheet-topology edge descriptors used by Neighbor Comparison.
 *
 * The expensive image matcher runs later in chunked form. This helper only establishes which
 * frame pairs should be measured, so progress can be reported in edge-count units.
 *
 * @param {number} frameCount
 * @returns {{from:number,to:number,kind:"horizontal"|"rowBreak"|"vertical"|"seam"}[]}
 */
function buildStabilizationEdgeDescriptors(frameCount) {
  const alignmentInfo = state.geometry.alignmentInfo;
  const cols = Math.max(1, alignmentInfo?.cols || 1);
  const rows = Math.max(1, alignmentInfo?.rows || Math.ceil(frameCount / cols));
  const edges = [];
  appendHorizontalStabilizationEdgeDescriptors(edges, cols, rows);
  // Row-break edges keep the solver aware of the scan order jump between the end of one printed
  // row and the start of the next, but they stay weak enough not to dominate the sheet topology.
  appendRowBreakStabilizationEdgeDescriptors(edges, cols, rows);
  appendVerticalStabilizationEdgeDescriptors(edges, cols, rows);
  if (frameCount > 1) {
    appendSeamStabilizationEdgeDescriptor(edges, frameCount);
  }
  return edges;
}

/**
 * Build or reuse the grayscale reference used by the alternate stabilization method.
 *
 * This path is currently using a pixelwise median image rather than a mean image as a temporary
 * experiment. It intentionally does not use any stabilized output, so the reference template never
 * feeds back on prior results.
 *
 * @returns {{data:Float32Array,weights:Float32Array,width:number,height:number,scaleX:number,scaleY:number} | null}
 */
function getAverageReferenceMatchData() {
  return timeProfiled("getAverageReferenceMatchData", () => {
    const matchFrames = getStabilizationMatchDataFrames();
    if (!matchFrames?.length) return null;
    if (state.frames.stabilizationAverageReference) {
      return state.frames.stabilizationAverageReference;
    }

    const first = matchFrames[0];
    const referenceData = new Float32Array(first.data.length);
    const frameCount = matchFrames.length;
    const pixelSamples = new Float32Array(frameCount);
    const middleIndex = Math.floor(frameCount / 2);
    const useEvenMedianAverage = frameCount % 2 === 0;
    for (let pixelIndex = 0; pixelIndex < referenceData.length; pixelIndex += 1) {
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        pixelSamples[frameIndex] = matchFrames[frameIndex].data[pixelIndex];
      }
      pixelSamples.sort();
      referenceData[pixelIndex] = useEvenMedianAverage
        ? 0.5 * (pixelSamples[middleIndex - 1] + pixelSamples[middleIndex])
        : pixelSamples[middleIndex];
    }

    const reference = {
      data: referenceData,
      weights: first.weights,
      width: first.width,
      height: first.height,
      scaleX: first.scaleX,
      scaleY: first.scaleY,
    };
    state.frames.stabilizationAverageReference = reference;
    return reference;
  });
}

/**
 * Measure one chunk of pairwise stabilization edges, yielding between chunks so the browser can
 * repaint Status and continue handling input on very large frame sets.
 *
 * @param {{data:Float32Array,weights:Float32Array,width:number,height:number}[]} frames
 * @param {{from:number,to:number,kind:"horizontal"|"rowBreak"|"vertical"|"seam"}[]} descriptors
 * @param {number} token
 * @returns {Promise<{from:number,to:number,dx:number,dy:number,kind:string,weight:number}[] | null>}
 */
async function measureStabilizationEdgesChunked(frames, descriptors, token) {
  const total = descriptors.length;
  const edges = [];
  state.processing.stabilizationMeasurementActive = true;
  state.processing.stabilizationMeasurementProgressCompleted = 0;
  state.processing.stabilizationMeasurementProgressTotal = total;
  updateStabilizationProgressUi();
  refreshStatusDisplay();
  setGeometryProcessingCursor(true);
  await waitForNextPaint();
  try {
    for (let start = 0; start < total; start += STABILIZATION_MEASUREMENT_CHUNK_SIZE) {
      if (token !== state.processing.stabilizationMeasurementToken) return null;
      const end = Math.min(total, start + STABILIZATION_MEASUREMENT_CHUNK_SIZE);
      for (let index = start; index < end; index += 1) {
        const descriptor = descriptors[index];
        const edge = buildStabilizationEdge(frames, descriptor.from, descriptor.to, descriptor.kind);
        if (edge) edges.push(edge);
      }
      state.processing.stabilizationMeasurementProgressCompleted = end;
      refreshStatusDisplay();
      if (end < total) {
        await waitForNextPaint();
      }
    }
    return edges;
  } finally {
    setGeometryProcessingCursor(false);
  }
}

/**
 * Start or join the chunked Neighbor Comparison measurement job for the current frame set.
 *
 * @param {{redrawWhenReady?: boolean}} [options]
 * @returns {Promise<{from:number,to:number,dx:number,dy:number,kind:string,weight:number}[] | null>}
 */
async function ensureStabilizationPairwiseMeasurements(options = {}) {
  const { redrawWhenReady = false } = options;
  const frameCount = state.geometry.frameCount;
  if (frameCount <= 1) {
    return null;
  }
  if (state.frames.stabilizationPairwise?.length) {
    return state.frames.stabilizationPairwise;
  }
  if (state.processing.stabilizationMeasurementPromise) {
    if (redrawWhenReady) {
      state.processing.stabilizationMeasurementRedrawPending = true;
    }
    return state.processing.stabilizationMeasurementPromise;
  }

  const frames = getStabilizationMatchDataFrames();
  if (!frames) {
    return null;
  }
  const descriptors = buildStabilizationEdgeDescriptors(frames.length);
  const token = state.processing.stabilizationMeasurementToken + 1;
  state.processing.stabilizationMeasurementToken = token;
  state.processing.stabilizationMeasurementRedrawPending = !!redrawWhenReady;
  state.processing.stabilizationMeasurementPromise = (async () => {
    try {
      const edges = await measureStabilizationEdgesChunked(frames, descriptors, token);
      if (token !== state.processing.stabilizationMeasurementToken || !edges) return null;
      state.frames.stabilizationPairwise = edges;
      return edges;
    } catch (error) {
      console.error(error);
      return null;
    } finally {
      if (token === state.processing.stabilizationMeasurementToken) {
        const needsRedraw = state.processing.stabilizationMeasurementRedrawPending;
        state.processing.stabilizationMeasurementActive = false;
        state.processing.stabilizationMeasurementProgressCompleted = 0;
        state.processing.stabilizationMeasurementProgressTotal = 0;
        state.processing.stabilizationMeasurementPromise = null;
        state.processing.stabilizationMeasurementRedrawPending = false;
        refreshStatusDisplay();
        if (needsRedraw && state.frames.stabilizationPairwise?.length) {
          // If the user watched frames before the async pairwise measurements finished, those
          // displayed outputs may be unstabilized. Once measurements are available, force derived
          // outputs to rebuild and then warm the final stabilized frame cache exactly once.
          invalidateStabilizationOffsetsCache();
          scheduleStabilizationPreviewUpdate();
          schedulePreviewFrameWarmup(state.processing.requestId);
        }
      }
    }
  })();
  return state.processing.stabilizationMeasurementPromise;
}

/**
 * Measure and cache the pairwise stabilization graph for the current frame set.
 *
 * This is the expensive part of markerless stabilization. It is separated from the final solve so
 * the measurements can be warmed in the background before the user first raises Stabilization
 * Strength above zero.
 *
 * The graph intentionally follows sheet topology rather than pure timeline order:
 * - horizontal edges within each printed row
 * - row-break edges between the end of one row and the start of the next
 * - vertical edges between rows
 * - one weak loop seam from the last frame back to the first
 *
 * That gives the solver access to the printed 2D layout, which is often a better prior for riso
 * sheets than treating the animation as a simple 1D chain.
 *
 * @returns {{from:number,to:number,dx:number,dy:number,kind:string,weight:number}[] | null}
 */
function getStabilizationPairwiseMeasurements() {
  return timeProfiled("getStabilizationPairwiseMeasurements", () => {
    const frameCount = state.geometry.frameCount;
    if (frameCount <= 1) return null;
    if (state.frames.stabilizationPairwise?.length) {
      return state.frames.stabilizationPairwise;
    }
    // Neighbor Comparison measurements now run in chunked background work so large frame sets do
    // not lock the main thread for tens of seconds at a time.
    void ensureStabilizationPairwiseMeasurements({ redrawWhenReady: true });
    return null;
  });
}

/**
 * Convert one stabilization edge set into the scalar graph expected by the least-squares solver.
 *
 * @param {{from:number,to:number,dx:number,dy:number,kind:string,weight:number}[]} edges
 * @param {"x"|"y"} axis
 * @returns {{from:number,to:number,delta:number,weight:number}[]}
 */
function projectStabilizationEdgesForAxis(edges, axis) {
  const key = axis === "x" ? "dx" : "dy";
  return edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    delta: edge[key],
    weight: edge.weight,
  }));
}

/**
 * Return the stabilization translation caps derived from one sample extracted frame.
 *
 * @param {HTMLCanvasElement} sampleFrame
 * @returns {{capX:number, capY:number}}
 */
function getStabilizationOffsetCaps(sampleFrame) {
  return {
    capX: sampleFrame.width * 0.10,
    capY: sampleFrame.height * 0.10,
  };
}

/**
 * Solve one per-frame x/y stabilization offset field from the weighted graph measurements.
 *
 * @param {{from:number,to:number,dx:number,dy:number,kind:string,weight:number}[]} edges
 * @param {number} frameCount
 * @returns {{x:number, y:number}[]}
 */
function solveStabilizationOffsetField(edges, frameCount) {
  const solvedX = solveGraphOffsets(projectStabilizationEdgesForAxis(edges, "x"), frameCount);
  const solvedY = solveGraphOffsets(projectStabilizationEdgesForAxis(edges, "y"), frameCount);
  return solvedX.map((x, index) => ({ x, y: solvedY[index] }));
}

/**
 * Return the post-extraction stabilization offsets for the current frame set.
 *
 * This solves for translation-only per-frame offsets over a small sheet-topology graph:
 * within-row horizontal neighbors, above/below vertical neighbors, and one weak loop-seam edge.
 * The solution is regularized toward zero and then centered so the average offset stays near zero.
 *
 * @returns {{x:number, y:number}[] | null}
 */
function getStabilizationOffsets() {
  return timeProfiled("getStabilizationOffsets", () => {
    if (!readConfig().stabilizationEnabled) {
      return null;
    }
    const frameCount = state.geometry.frameCount;
    if (frameCount <= 1) {
      return null;
    }
    if (state.frames.stabilizationOffsets?.length === frameCount) {
      return state.frames.stabilizationOffsets;
    }
    const sampleFrame = getStabilizationSourceFrameCanvas(0);
    if (!sampleFrame) {
      return null;
    }
    const method = readConfig().stabilizationMethod;
    let offsets = null;
    if (method === "difference-from-average") {
      const reference = getAverageReferenceMatchData();
      const matchFrames = getStabilizationMatchDataFrames();
      if (!reference || !matchFrames?.length) {
        return null;
      }
      offsets = matchFrames.map((frame) => {
        const shift = estimateLoopPairShift(reference, frame);
        return { x: shift.dx, y: shift.dy };
      });
      centerOffsetsAroundZero(offsets);
    } else {
      const edges = getStabilizationPairwiseMeasurements();
      if (!edges?.length) {
        void ensureStabilizationPairwiseMeasurements({ redrawWhenReady: true });
        return null;
      }
      offsets = solveStabilizationOffsetField(edges, frameCount);
    }
    const { capX, capY } = getStabilizationOffsetCaps(sampleFrame);
    clampOffsetsInPlace(offsets, capX, capY);
    centerOffsetsAroundZero(offsets);
    state.frames.stabilizationOffsets = offsets;
    return offsets;
  });
}

/**
 * Warm the expensive markerless stabilization measurements after processing so the first
 * stabilization enable/preview does not have to pay the full startup cost.
 *
 * @param {number} requestId
 * @returns {void}
 */
function scheduleMarkerlessStabilizationWarmup(requestId) {
  window.setTimeout(() => {
    if (requestId !== state.processing.requestId) {
      return;
    }
    if (!readConfig().stabilizationEnabled) {
      return;
    }
    scheduleCurrentStabilizationWarmup();
  }, 0);
}

/**
 * Warm whichever markerless stabilization method is currently selected without forcing a full solve.
 *
 * This avoids the first stabilization preview from having to build all matcher state synchronously
 * on the interaction path.
 *
 * @returns {void}
 */
function scheduleCurrentStabilizationWarmup() {
  window.setTimeout(() => {
    // Stabilization warmup applies to both non-marker pipelines (markerless + per-frame).
    if (readConfig().alignmentPipeline === "markers") {
      return;
    }
    if (!readConfig().stabilizationEnabled) {
      return;
    }
    if (state.processing.active) {
      return;
    }
    try {
      const warmupProfile = beginTimingProfile("Warmup");
      if (readConfig().stabilizationMethod === "difference-from-average") {
        timeProfiled("getAverageReferenceMatchData", () => getAverageReferenceMatchData());
        lastWarmupTimingSummary = finishTimingProfile(warmupProfile);
      } else if (!state.frames.stabilizationPairwise?.length) {
        void ensureStabilizationPairwiseMeasurements();
        activeTimingProfile = null;
        lastWarmupTimingSummary = "";
      } else {
        lastWarmupTimingSummary = finishTimingProfile(warmupProfile);
      }
      if (lastBaseStatusText) {
        refreshStatusDisplay();
      }
    } catch (error) {
      activeTimingProfile = null;
      console.error(error);
    }
  }, 0);
}

/**
 * Format the measured pairwise stabilization shifts for the Status panel.
 *
 * @returns {string}
 */
function getStabilizationDebugText() {
  if (!readConfig().stabilizationEnabled) return "";
  const edges = state.frames.stabilizationPairwise;
  if (!edges?.length) return "";
  const lines = ["", "Stabilization shifts:"];
  for (const edge of edges) {
    const label =
      edge.kind === "vertical"
        ? "Vertical"
        : edge.kind === "horizontal"
          ? "Horizontal"
          : edge.kind === "rowBreak"
            ? "Row break"
          : "Seam";
    lines.push(`${label} ${edge.from}-${edge.to} dx,dy: ${edge.dx},${edge.dy} w:${edge.weight.toFixed(2)}`);
  }
  return lines.join("\n");
}

/**
 * Return one stabilized base frame canvas when stabilization is enabled.
 *
 * @param {number} index
 * @returns {HTMLCanvasElement | null}
 */
function getStabilizedFrameCanvas(index) {
  return timeProfiled("getStabilizedFrameCanvas", () => {
    const baseFrame = getBaseFrameCanvas(index);
    if (!baseFrame) return null;
    const config = readConfig();
    if (!config.stabilizationEnabled) return baseFrame;
    if (
      state.frames.stabilizedCache.has(index) &&
      state.frames.stabilizedOutputEpoch.get(index) === state.frames.outputEpoch
    ) {
      return state.frames.stabilizedCache.get(index);
    }

    const offsets = getStabilizationOffsets();
    if (!offsets || !offsets[index]) return baseFrame;
    const stabilizationStrengthScale = Math.max(0, config.stabilizationStrengthPct || 0) / 100;
    if (stabilizationStrengthScale <= 1e-9) return baseFrame;
    const stabilized = extractProcessedFrameCanvas(index, {
      x: offsets[index].x * stabilizationStrengthScale,
      y: offsets[index].y * stabilizationStrengthScale,
    });
    if (!stabilized) return baseFrame;
    state.frames.stabilizedCache.set(index, stabilized);
    state.frames.stabilizedOutputEpoch.set(index, state.frames.outputEpoch);
    return stabilized;
  });
}

/**
 * Format the current post-crop aspect ratio as a fixed-precision readout.
 *
 * @returns {string}
 */
function getCurrentCropAspectRatioText() {
  const alignmentInfo = state.geometry.alignmentInfo;
  if (!alignmentInfo) return "--";
  const config = readConfig();
  const cellWidth = alignmentInfo.gridBounds.width / alignmentInfo.cols;
  const cellHeight = alignmentInfo.gridBounds.height / alignmentInfo.rows;
  let croppedWidth = Math.max(1, cellWidth - config.crop.left - config.crop.right);
  let croppedHeight = Math.max(1, cellHeight - config.crop.top - config.crop.bottom);
  if (config.postCropGeometry.rotate90Cw) {
    [croppedWidth, croppedHeight] = [croppedHeight, croppedWidth];
  }
  const widthPx = Math.max(1, Math.round(croppedWidth));
  const heightPx = Math.max(1, Math.round(croppedHeight));
  return `${(croppedWidth / croppedHeight).toFixed(3)} (${widthPx}\u00d7${heightPx})`;
}

/**
 * Apply the post-crop output-size scaling used by preview and export.
 *
 * These scaled canvases are cached in `state.frames.base`, so the chosen resize path only runs
 * once per frame unless geometry/export-size inputs change and invalidate that cache.
 *
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {number} outputWidthPx
 * @param {number} outputHeightPx
 * @param {string} resampling
 * @returns {HTMLCanvasElement}
 */
function scaleOutputCanvas(sourceCanvas, outputWidthPx, outputHeightPx, resampling) {
  if (!sourceCanvas) return sourceCanvas;
  const targetWidth = Math.max(1, Math.round(outputWidthPx || sourceCanvas.width));
  const targetHeight = Math.max(1, Math.round(outputHeightPx || sourceCanvas.height));
  if (targetWidth === sourceCanvas.width && targetHeight === sourceCanvas.height) {
    return sourceCanvas;
  }
  if (!bUseOpenCvOutputScaling) {
    const scaled = document.createElement("canvas");
    scaled.width = targetWidth;
    scaled.height = targetHeight;
    const ctx = scaled.getContext("2d");
    // Browser-canvas fallback for final output-size change; geometric warps still happen in OpenCV.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = (resampling === "linear") ? "medium" : "high";
    ctx.drawImage(sourceCanvas, 0, 0, scaled.width, scaled.height);
    return scaled;
  }

  const src = cv.imread(sourceCanvas);
  const dst = new cv.Mat();
  const scaled = document.createElement("canvas");
  try {
    // OpenCV path for final output scaling, useful when comparing very small outputs where the
    // browser's drawImage downsampling can look noticeably worse.
    cv.resize(
      src,
      dst,
      new cv.Size(targetWidth, targetHeight),
      0,
      0,
      getCvInterpolationFlag(resampling)
    );
    scaled.width = targetWidth;
    scaled.height = targetHeight;
    cv.imshow(scaled, dst);
    return scaled;
  } finally {
    src.delete();
    dst.delete();
  }
}

/**
 * During markerless phase scrubbing, render only enough resolution for the live Preview panel.
 * Full output resolution is restored on slider release when caches are invalidated normally.
 *
 * @param {number} outputWidthPx
 * @param {number} outputHeightPx
 * @returns {{width:number,height:number}}
 */
function getInteractiveOutputSize(outputWidthPx, outputHeightPx) {
  if (!state.preview.markerlessPhaseScrubbing) {
    return {
      width: outputWidthPx,
      height: outputHeightPx,
    };
  }
  const previewWidth = Math.max(
    1,
    Math.round(
      dom.gifPreviewCanvas.width ||
      dom.gifPreviewCanvas.clientWidth ||
      outputWidthPx ||
      1
    )
  );
  if (!outputWidthPx || outputWidthPx <= 0 || !outputHeightPx || outputHeightPx <= 0) {
    return {
      width: previewWidth,
      height: outputHeightPx,
    };
  }
  const scale = Math.min(1, previewWidth / outputWidthPx);
  return {
    width: Math.max(1, Math.round(outputWidthPx * scale)),
    height: Math.max(1, Math.round(outputHeightPx * scale)),
  };
}

/**
 * Apply the post-crop flip/rotation options to one extracted frame.
 *
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {{flipHorizontal:boolean, flipVertical:boolean, rotate90Cw:boolean}} geometry
 * @returns {HTMLCanvasElement}
 */
function transformOutputCanvas(sourceCanvas, geometry) {
  if (!sourceCanvas) return sourceCanvas;
  const flipHorizontal = !!geometry?.flipHorizontal;
  const flipVertical = !!geometry?.flipVertical;
  const rotate90Cw = !!geometry?.rotate90Cw;
  if (!flipHorizontal && !flipVertical && !rotate90Cw) return sourceCanvas;

  let current = sourceCanvas;
  if (flipHorizontal) current = flipCanvas(current, true, false);
  if (flipVertical) current = flipCanvas(current, false, true);
  if (rotate90Cw) current = rotateCanvas90Cw(current);
  return current;
}

/**
 * Flip a canvas horizontally and/or vertically.
 *
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {boolean} flipHorizontal
 * @param {boolean} flipVertical
 * @returns {HTMLCanvasElement}
 */
function flipCanvas(sourceCanvas, flipHorizontal, flipVertical) {
  const flipped = document.createElement("canvas");
  flipped.width = sourceCanvas.width;
  flipped.height = sourceCanvas.height;
  const ctx = flipped.getContext("2d");
  ctx.translate(flipHorizontal ? flipped.width : 0, flipVertical ? flipped.height : 0);
  ctx.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
  ctx.drawImage(sourceCanvas, 0, 0);
  return flipped;
}

/**
 * Rotate a canvas 90 degrees clockwise.
 *
 * @param {HTMLCanvasElement} sourceCanvas
 * @returns {HTMLCanvasElement}
 */
function rotateCanvas90Cw(sourceCanvas) {
  const rotated = document.createElement("canvas");
  rotated.width = sourceCanvas.height;
  rotated.height = sourceCanvas.width;
  const ctx = rotated.getContext("2d");
  ctx.translate(rotated.width, 0);
  ctx.rotate(Math.PI * 0.5);
  ctx.drawImage(sourceCanvas, 0, 0);
  return rotated;
}

/**
 * Lazily apply appearance adjustments to one cached base frame.
 *
 * @param {number} index
 * @returns {HTMLCanvasElement | null}
 */
function getAdjustedFrameCanvas(index) {
  return timeProfiled("getAdjustedFrameCanvas", () => {
    const baseFrame = getStabilizedFrameCanvas(index);
    if (!baseFrame) return null;
    const filters = readConfig().filters;
    if (!hasAppearanceAdjustments(filters)) return baseFrame;
    if (
      state.frames.adjustedCache.has(index) &&
      state.frames.adjustedOutputEpoch.get(index) === state.frames.outputEpoch
    ) {
      return state.frames.adjustedCache.get(index);
    }
    const adjustedFrame = document.createElement("canvas");
    timeProfiled("applyVisualAdjustments", () => applyVisualAdjustments(baseFrame, adjustedFrame, filters));
    state.frames.adjustedCache.set(index, adjustedFrame);
    state.frames.adjustedOutputEpoch.set(index, state.frames.outputEpoch);
    return adjustedFrame;
  });
}

/**
 * Estimate the best translation to align the second frame to the first using a 21x21 search over
 * cumulative absolute pixel differences in luma space.
 *
 * The search is performed on sampled grayscale frames, not full-resolution exports. Matching now
 * defaults to flat per-pixel weights.
 *
 * @param {HTMLCanvasElement | {data:Float32Array,weights:Float32Array,width:number,height:number,scaleX:number,scaleY:number}} currentFrame
 * @param {HTMLCanvasElement | {data:Float32Array,weights:Float32Array,width:number,height:number,scaleX:number,scaleY:number}} nextFrame
 * @returns {{dx:number, dy:number, dxSample:number, dySample:number}}
 */
function estimateLoopPairShift(currentFrame, nextFrame) {
  return timeProfiled("estimateLoopPairShift", () => {
    const currentData = currentFrame?.data instanceof Float32Array ? currentFrame : getFrameMatchData(currentFrame);
    const nextData = nextFrame?.data instanceof Float32Array ? nextFrame : getFrameMatchData(nextFrame);
    const maxShiftX = Math.min(10, Math.floor(currentData.width / 2));
    const maxShiftY = Math.min(10, Math.floor(currentData.height / 2));
    let bestDx = 0;
    let bestDy = 0;
    let bestScore = Infinity;

    for (let dy = -maxShiftY; dy <= maxShiftY; dy++) {
      for (let dx = -maxShiftX; dx <= maxShiftX; dx++) {
        const score = computeShiftDifferenceScore(currentData, nextData, currentData.width, currentData.height, dx, dy);
        if (score < bestScore) {
          bestScore = score;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }
    const scaleX = 0.5 * ((currentData.scaleX || 1) + (nextData.scaleX || 1));
    const scaleY = 0.5 * ((currentData.scaleY || 1) + (nextData.scaleY || 1));
    return {
      dx: bestDx * scaleX,
      dy: bestDy * scaleY,
      dxSample: bestDx,
      dySample: bestDy,
    };
  });
}

/**
 * Convert a frame canvas into sampled grayscale luma for pairwise stabilization matching.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {{data:Float32Array, weights:Float32Array, width:number, height:number, scaleX:number, scaleY:number}}
 */
function getFrameMatchData(canvas) {
  return timeProfiled("getFrameMatchData", () => {
    const sampleStep = Math.max(1, Math.ceil(Math.sqrt((canvas.width * canvas.height) / 60000)));
    const sampleWidth = Math.max(1, Math.floor(canvas.width / sampleStep));
    const sampleHeight = Math.max(1, Math.floor(canvas.height / sampleStep));
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = sampleWidth;
    sampleCanvas.height = sampleHeight;
    const sampleCtx = sampleCanvas.getContext("2d");
    sampleCtx.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
    const imageData = sampleCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;
    const luma = new Float32Array(sampleWidth * sampleHeight);
    for (let i = 0, j = 0; i < imageData.length; i += 4, j++) {
      luma[j] = (0.299 * imageData[i]) + (0.587 * imageData[i + 1]) + (0.114 * imageData[i + 2]);
    }
    return {
      data: luma,
      weights: getFrameMatchWeights(sampleWidth, sampleHeight, false),
      width: sampleWidth,
      height: sampleHeight,
      scaleX: canvas.width / sampleWidth,
      scaleY: canvas.height / sampleHeight,
    };
  });
}

/**
 * Build or reuse per-pixel match weights for the sampled stabilization frame.
 *
 * Flat weighting is the active path. The radial-weight branch is intentionally retained but
 * currently unused so the experiment can be revisited without reconstructing the implementation.
 *
 * @param {number} width
 * @param {number} height
 * @param {boolean} [emphasizePeriphery=false]
 * @returns {Float32Array}
 */
function getFrameMatchWeights(width, height, emphasizePeriphery = false) {
  const key = `${width}x${height}:${emphasizePeriphery ? "periphery" : "uniform"}`;
  const cached = FRAME_MATCH_WEIGHT_CACHE.get(key);
  if (cached) return cached;

  const weights = new Float32Array(width * height);
  if (!emphasizePeriphery) {
    weights.fill(1);
    FRAME_MATCH_WEIGHT_CACHE.set(key, weights);
    return weights;
  }
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const radius = Math.max(1e-6, Math.min(width, height) * 0.5);

  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dist = Math.sqrt((dx * dx) + (dy * dy));
      weights[(y * width) + x] = Math.max(0, Math.min(1, dist / radius));
    }
  }

  FRAME_MATCH_WEIGHT_CACHE.set(key, weights);
  return weights;
}

/**
 * Score one integer translation between two luma frames using average absolute difference on the
 * overlapping region only.
 *
 * @param {{data:Float32Array,weights:Float32Array,width:number,height:number}} frameA
 * @param {{data:Float32Array,weights:Float32Array,width:number,height:number}} frameB
 * @param {number} width
 * @param {number} height
 * @param {number} dx
 * @param {number} dy
 * @returns {number}
 */
function computeShiftDifferenceScore(frameA, frameB, width, height, dx, dy) {
  const overlapX0 = Math.max(0, -dx);
  const overlapY0 = Math.max(0, -dy);
  const overlapX1 = Math.min(width, width - dx);
  const overlapY1 = Math.min(height, height - dy);
  if (overlapX1 <= overlapX0 || overlapY1 <= overlapY0) return Infinity;

  let diffSum = 0;
  let normSum = 0;
  for (let y = overlapY0; y < overlapY1; y++) {
    const rowA = y * width;
    const rowB = (y + dy) * width;
    for (let x = overlapX0; x < overlapX1; x++) {
      const indexA = rowA + x;
      const indexB = rowB + x + dx;
      const weight = 0.5 * (frameA.weights[indexA] + frameB.weights[indexB]);
      diffSum += Math.abs(frameA.data[indexA] - frameB.data[indexB]) * weight;
      normSum += weight;
    }
  }
  return diffSum / Math.max(1e-6, normSum);
}

/**
 * Solve per-frame offsets from a general graph of pairwise displacement constraints with an L2
 * penalty on the absolute offsets.
 *
 * Each edge contributes a constraint of the form:
 * `p[to] - p[from] ~= delta`
 * and the regularized normal equations keep the absolute offsets modest overall.
 *
 * @param {{from:number,to:number,delta:number,weight?:number}[]} edges
 * @param {number} count
 * @returns {number[]}
 */
function solveGraphOffsets(edges, count) {
  if (!count || !edges.length) return new Array(count).fill(0);
  const lambda = Math.max(0, readConfig().stabilizationLambda);
  const matrix = Array.from({ length: count }, () => new Array(count).fill(0));
  const rhs = new Array(count).fill(0);

  for (const edge of edges) {
    const from = edge.from;
    const to = edge.to;
    const delta = edge.delta;
    const weight = Math.max(0, Number(edge.weight) || 0);
    if (weight <= 0) continue;
    matrix[from][from] += weight;
    matrix[to][to] += weight;
    matrix[from][to] -= weight;
    matrix[to][from] -= weight;
    rhs[from] -= weight * delta;
    rhs[to] += weight * delta;
  }

  for (let i = 0; i < count; i++) {
    matrix[i][i] += lambda;
  }

  const solved = solveLinearSystem(matrix, rhs);
  if (!solved) {
    return new Array(count).fill(0);
  }
  const mean = solved.reduce((sum, value) => sum + value, 0) / count;
  return solved.map((value) => value - mean);
}

/**
 * Downweight suspicious stabilization matches so row seams and boundary-saturated searches do not
 * dominate the solve.
 *
 * The weights intentionally encode qualitative trust, not strict probabilities:
 * - horizontal within-row comparisons are trusted most
 * - vertical comparisons are helpful but weaker
 * - row breaks and the loop seam are retained at low weight because they are often contaminated
 *   by discontinuities in the artwork or by end-of-row extraction bias
 *
 * @param {{kind:string,dx:number,dy:number}} edge
 * @returns {number}
 */
function getStabilizationEdgeWeight(edge) {
  let weight = 1;
  if (edge.kind === "horizontal") weight = 1.0;
  else if (edge.kind === "vertical") weight = 0.6;
  else if (edge.kind === "rowBreak" || edge.kind === "seam") {
    weight = 0.1;
  }

  const maxAbs = Math.max(Math.abs(edge.dx), Math.abs(edge.dy));
  if (maxAbs >= 10) {
    weight *= 0.2;
  } else if (maxAbs >= 9) {
    weight *= 0.35;
  } else if (maxAbs >= 8) {
    weight *= 0.55;
  }
  return weight;
}

/**
 * Solve a dense linear system with Gaussian elimination and partial pivoting.
 *
 * The stabilization system is tiny (one unknown per frame), so a simple dense solver is
 * sufficient and keeps the implementation dependency-free.
 *
 * @param {number[][]} matrix
 * @param {number[]} rhs
 * @returns {number[] | null}
 */
function solveLinearSystem(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, rowIndex) => [...row, rhs[rowIndex]]);

  for (let pivot = 0; pivot < n; pivot++) {
    let bestRow = pivot;
    let bestValue = Math.abs(a[pivot][pivot]);
    for (let row = pivot + 1; row < n; row++) {
      const value = Math.abs(a[row][pivot]);
      if (value > bestValue) {
        bestValue = value;
        bestRow = row;
      }
    }
    if (bestValue < 1e-9) {
      return null;
    }
    if (bestRow !== pivot) {
      const temp = a[pivot];
      a[pivot] = a[bestRow];
      a[bestRow] = temp;
    }

    const pivotValue = a[pivot][pivot];
    for (let col = pivot; col <= n; col++) {
      a[pivot][col] /= pivotValue;
    }

    for (let row = 0; row < n; row++) {
      if (row === pivot) continue;
      const factor = a[row][pivot];
      if (Math.abs(factor) < 1e-12) continue;
      for (let col = pivot; col <= n; col++) {
        a[row][col] -= factor * a[pivot][col];
      }
    }
  }

  return a.map((row) => row[n]);
}

/**
 * Clamp solved offsets to the allowed translation limits while preserving their overall structure.
 *
 * @param {{x:number,y:number}[]} offsets
 * @param {number} capX
 * @param {number} capY
 * @returns {void}
 */
function clampOffsetsInPlace(offsets, capX, capY) {
  const maxAbsX = Math.max(...offsets.map((offset) => Math.abs(offset.x)), 0);
  const maxAbsY = Math.max(...offsets.map((offset) => Math.abs(offset.y)), 0);
  const scaleX = maxAbsX > capX && maxAbsX > 1e-6 ? (capX / maxAbsX) : 1;
  const scaleY = maxAbsY > capY && maxAbsY > 1e-6 ? (capY / maxAbsY) : 1;
  for (const offset of offsets) {
    offset.x *= scaleX;
    offset.y *= scaleY;
  }
}

/**
 * Keep the average correction near zero after any clamping/scaling step.
 *
 * @param {{x:number,y:number}[]} offsets
 * @returns {void}
 */
function centerOffsetsAroundZero(offsets) {
  if (!offsets.length) return;
  const meanX = offsets.reduce((sum, offset) => sum + offset.x, 0) / offsets.length;
  const meanY = offsets.reduce((sum, offset) => sum + offset.y, 0) / offsets.length;
  for (const offset of offsets) {
    offset.x -= meanX;
    offset.y -= meanY;
  }
}

/**
 * Convert the markerless manual phase sliders into a source-quad offset in rectified-sheet
 * pixels. The autocorrelation estimate remains the baseline; these sliders shift extraction
 * relative to that baseline by up to half a nominal frame cell in each direction.
 *
 * @param {ReturnType<typeof readConfig>} config
 * @param {object | null} alignmentInfo
 * @returns {{x:number,y:number}}
 */
function getMarkerlessPhaseSourceOffset(config, alignmentInfo) {
  if (!alignmentInfo || config.alignmentPipeline !== "markerless") {
    return { x: 0, y: 0 };
  }
  const cellWidth = alignmentInfo.gridBounds.width / Math.max(1, alignmentInfo.cols);
  const cellHeight = alignmentInfo.gridBounds.height / Math.max(1, alignmentInfo.rows);
  return {
    x: cellWidth * (config.markerlessPhaseX || 0),
    y: cellHeight * (config.markerlessPhaseY || 0),
  };
}

/**
 * Add two source-space extraction offsets together.
 *
 * @param {{x:number,y:number}} baseOffset
 * @param {{x:number,y:number}} extraOffset
 * @returns {{x:number,y:number}}
 */
function combineSourceOffsets(baseOffset, extraOffset) {
  return {
    x: (Number(baseOffset?.x) || 0) + (Number(extraOffset?.x) || 0),
    y: (Number(baseOffset?.y) || 0) + (Number(extraOffset?.y) || 0),
  };
}

/**
 * Convert the markerless vertical drift-compensation slider into a frame-distributed vertical source offset.
 *
 * This is a post-stabilization extraction nudge intended to counter vertical drift. The slider
 * value represents the total compensation over the full animation, measured as a fraction of one
 * frame height. That total is distributed evenly from the first frame to the last frame.
 *
 * @param {ReturnType<typeof readConfig>} config
 * @param {object | null} alignmentInfo
 * @param {number} frameIndex
 * @returns {{x:number,y:number}}
 */
function getMarkerlessVerticalDriftSourceOffset(config, alignmentInfo, frameIndex) {
  // Vertical Drift Compensation is enabled in both non-marker pipelines (markerless + per-frame).
  if (!alignmentInfo || config.alignmentPipeline === "markers") {
    return { x: 0, y: 0 };
  }
  const cellHeight = alignmentInfo.gridBounds.height / Math.max(1, alignmentInfo.rows);
  const totalDrift = cellHeight * (config.verticalDriftCompensation || 0);
  const frameCount = Math.max(1, alignmentInfo.rows * alignmentInfo.cols);
  const frameDenominator = Math.max(1, frameCount - 1);
  const frameFactor = frameIndex / frameDenominator;
  return {
    x: 0,
    y: totalDrift * frameFactor,
  };
}

/**
 * Return the automatic markerless extraction offset before any explicit caller-supplied shift.
 *
 * This combines the autocorrelation-based phase offset with optional drift compensation. Frame-
 * specific stabilization is supplied separately by the caller so that different extraction paths
 * can opt in or out without duplicating the automatic baseline logic.
 *
 * @param {ReturnType<typeof readConfig>} config
 * @param {object | null} alignmentInfo
 * @param {number} frameIndex
 * @param {boolean} includeDriftCompensation
 * @returns {{x:number,y:number}}
 */
function getAutomaticMarkerlessSourceOffset(config, alignmentInfo, frameIndex, includeDriftCompensation = true) {
  const phaseOffset = getMarkerlessPhaseSourceOffset(config, alignmentInfo);
  if (!includeDriftCompensation) {
    return phaseOffset;
  }
  const driftOffset = getMarkerlessVerticalDriftSourceOffset(config, alignmentInfo, frameIndex);
  return combineSourceOffsets(phaseOffset, driftOffset);
}

/**
 * Average the applied per-frame stabilization offsets for the frames sharing one markerless corner.
 *
 * Markerless stabilization is solved per frame, but the Frame Corners panel displays one tile per
 * shared corner location. Averaging the neighboring frame translations gives one practical display
 * position for that shared corner that matches the currently stabilized extraction regime.
 *
 * @param {number} col
 * @param {number} row
 * @param {object | null} alignmentInfo
 * @returns {{x:number,y:number}}
 */
function getMarkerlessCornerStabilizationOffset(col, row, alignmentInfo) {
  // Stabilization and the Frame Corners panel are shared by both non-marker pipelines.
  if (!alignmentInfo || readConfig().alignmentPipeline === "markers") {
    return { x: 0, y: 0 };
  }
  const offsets = getStabilizationOffsets();
  if (!offsets?.length || !readConfig().stabilizationEnabled) {
    return { x: 0, y: 0 };
  }
  const samples = [];
  const frameCoords = [
    { col: col - 1, row: row - 1 },
    { col, row: row - 1 },
    { col: col - 1, row },
    { col, row },
  ];
  for (const frame of frameCoords) {
    if (frame.col < 0 || frame.row < 0 || frame.col >= alignmentInfo.cols || frame.row >= alignmentInfo.rows) {
      continue;
    }
    const index = frame.row * alignmentInfo.cols + frame.col;
    const offset = offsets[index];
    if (!offset) continue;
    samples.push(offset);
  }
  if (!samples.length) {
    return { x: 0, y: 0 };
  }
  const meanX = samples.reduce((sum, offset) => sum + offset.x, 0) / samples.length;
  const meanY = samples.reduce((sum, offset) => sum + offset.y, 0) / samples.length;
  return {
    x: meanX,
    y: meanY,
  };
}

/**
 * Return the current per-frame stabilization translation applied during markerless extraction.
 *
 * @param {number} index
 * @returns {{x:number,y:number}}
 */
function getFrameStabilizationSourceOffset(index) {
  const offsets = getStabilizationOffsets();
  if (!offsets?.[index] || !readConfig().stabilizationEnabled) {
    return { x: 0, y: 0 };
  }
  return {
    x: offsets[index].x,
    y: offsets[index].y,
  };
}

/**
 * Return the stored post-stabilization nudge for one markerless corner override.
 *
 * In markerless mode, manual overrides are interpreted as extraction/display-space deltas relative
 * to the automatically estimated corner position after phase and stabilization have been applied.
 *
 * @param {number} col
 * @param {number} row
 * @returns {{x:number,y:number}}
 */
function getMarkerlessCornerManualNudge(col, row) {
  // Frame Corners overrides (stored as corner nudges) are enabled in markerless and per-frame.
  if (readConfig().alignmentPipeline === "markers") {
    return { x: 0, y: 0 };
  }
  const override = state.geometry.manualMarkerOverrides.get(getMarkerKey(col, row));
  if (!override) return { x: 0, y: 0 };
  return {
    x: Number.isFinite(override.x) ? override.x : 0,
    y: Number.isFinite(override.y) ? override.y : 0,
  };
}

/**
 * Build the markerless display-space corner position shown in the Frame Corners panel.
 *
 * The displayed corner is not just the raw pipeline estimate. It is the current automatic corner
 * position after applying phase offsets and any solved stabilization, plus an optional stored
 * post-stabilization manual nudge.
 *
 * @param {object} sourceMarker
 * @param {number} col
 * @param {number} row
 * @param {object} alignmentInfo
 * @param {boolean} [includeManualNudge=true]
 * @returns {{x:number,y:number,roiCenterX:number,roiCenterY:number,detectedX:number,detectedY:number,autoDetectedX?:number,autoDetectedY?:number}}
 */
function getMarkerlessDisplayedCorner(sourceMarker, col, row, alignmentInfo, includeManualNudge = true) {
  const phaseOffset = getMarkerlessPhaseSourceOffset(readConfig(), alignmentInfo);
  const stabilizationOffset = getMarkerlessCornerStabilizationOffset(col, row, alignmentInfo);
  const manualNudge = includeManualNudge ? getMarkerlessCornerManualNudge(col, row) : { x: 0, y: 0 };
  const totalX = phaseOffset.x + stabilizationOffset.x + manualNudge.x;
  const totalY = phaseOffset.y + stabilizationOffset.y + manualNudge.y;
  return {
    x: sourceMarker.x + totalX,
    y: sourceMarker.y + totalY,
    roiCenterX: (Number.isFinite(sourceMarker.roiCenterX) ? sourceMarker.roiCenterX : sourceMarker.x) + totalX,
    roiCenterY: (Number.isFinite(sourceMarker.roiCenterY) ? sourceMarker.roiCenterY : sourceMarker.y) + totalY,
    detectedX: sourceMarker.detectedX + totalX,
    detectedY: sourceMarker.detectedY + totalY,
    autoDetectedX: Number.isFinite(sourceMarker.autoDetectedX) ? sourceMarker.autoDetectedX + totalX : undefined,
    autoDetectedY: Number.isFinite(sourceMarker.autoDetectedY) ? sourceMarker.autoDetectedY + totalY : undefined,
  };
}

/**
 * Build a lightweight frame-specific extraction view of markerless corner nudges.
 *
 * Markerless manual overrides are post-stabilization extraction nudges, so they should affect only
 * the four corners surrounding the extracted frame and should not feed back into the stabilization
 * solve or the shared alignment lattice.
 *
 * @param {object} alignmentInfo
 * @param {number} col
 * @param {number} row
 * @returns {object}
 */
function buildMarkerlessExtractionInfoForFrame(alignmentInfo, col, row) {
  const keys = [
    getMarkerKey(col, row),
    getMarkerKey(col + 1, row),
    getMarkerKey(col + 1, row + 1),
    getMarkerKey(col, row + 1),
  ];
  const markerLookup = new Map();
  for (const key of keys) {
    const marker = alignmentInfo.markerLookup.get(key);
    if (!marker) continue;
    const [markerCol, markerRow] = key.split(",").map(Number);
    const nudge = getMarkerlessCornerManualNudge(markerCol, markerRow);
    markerLookup.set(key, {
      ...marker,
      detectedX: marker.detectedX + nudge.x,
      detectedY: marker.detectedY + nudge.y,
    });
  }
  return {
    ...alignmentInfo,
    markerLookup,
  };
}

/**
 * Ensure a grayscale rectified-sheet mat is cached for markerless corner-tile rendering.
 *
 * @returns {cv.Mat | null}
 */
function ensureRectifiedGrayMat() {
  const rectifiedMat = ensureBaseRectifiedMat();
  if (!rectifiedMat) return null;
  if (!state.geometry.baseRectifiedGrayMat) {
    state.geometry.baseRectifiedGrayMat = new cv.Mat();
    cv.cvtColor(
      rectifiedMat,
      state.geometry.baseRectifiedGrayMat,
      rectifiedMat.type() === cv.CV_8UC4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_BGR2GRAY
    );
  }
  return state.geometry.baseRectifiedGrayMat;
}

/**
 * Build one grayscale diagnostic tile centered on a frame corner, padding with edge pixels when
 * the shifted markerless corner falls outside the rectified sheet.
 *
 * @param {cv.Mat} grayMat
 * @param {{x:number,y:number,col:number,row:number}} expected
 * @param {object} alignmentInfo
 * @param {number} crossRoiScale
 * @returns {object}
 */
function buildMarkerlessCornerTile(grayMat, expected, alignmentInfo, crossRoiScale) {
  const side = getMarkerlessCornerTileSidePx(alignmentInfo, crossRoiScale);
  const roi = new cv.Mat();
  const roiCenter = (side - 1) * 0.5;
  const tx = roiCenter - expected.x;
  const ty = roiCenter - expected.y;
  const affine = cv.matFromArray(2, 3, cv.CV_64F, [1, 0, tx, 0, 1, ty]);
  try {
    cv.warpAffine(grayMat, roi, affine, new cv.Size(side, side), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    const canvas = document.createElement("canvas");
    canvas.width = roi.cols;
    canvas.height = roi.rows;
    cv.imshow(canvas, roi);
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
    return {
      ...expected,
      kind: "markerless",
      markerType: "markerless",
      roiCenterX: expected.x,
      roiCenterY: expected.y,
      detectedX: expected.x,
      detectedY: expected.y,
      dx: 0,
      dy: 0,
      darkFrac: 0,
      confidence: 1,
      accepted: true,
      localX: roiCenter,
      localY: roiCenter,
      canvas,
    };
  } finally {
    affine.delete();
    roi.delete();
  }
}

/**
 * Compute the markerless corner-tile side length used by both the normal and scrub-preview paths.
 *
 * Sharing this helper keeps Panel 3 tile dimensions stable while Post-Rotation is scrubbed, so
 * only the sampled content moves and the tile apertures themselves do not visually resize.
 *
 * @param {object} alignmentInfo
 * @param {number} crossRoiScale
 * @returns {number}
 */
function getMarkerlessCornerTileSidePx(alignmentInfo, crossRoiScale) {
  const cellW = alignmentInfo.gridBounds.width / alignmentInfo.cols;
  const cellH = alignmentInfo.gridBounds.height / alignmentInfo.rows;
  const roiHalf = Math.max(10, Math.round(Math.min(cellW, cellH) * 0.18 * crossRoiScale));
  return capMarkerlessCornerTileSidePx(Math.max(1, roiHalf * 2 + 1), crossRoiScale);
}

/**
 * Build one preview-only alignment tile from the rotated rectified-sheet preview canvas.
 *
 * This keeps Post-Rotation scrubbing cheap by reusing preview-scale pixels rather than rebuilding
 * full-resolution OpenCV ROIs on every slider tick. The tile samples a fixed square aperture from
 * the already-rotated page preview, so content slides through the tile the way the full page
 * would move under a stationary window.
 *
 * @param {HTMLCanvasElement} previewCanvas
 * @param {{x:number,y:number,col:number,row:number}} expected
 * @param {object} alignmentInfo
 * @param {object | null} templateTile
 * @param {number} [targetSizeOverride=0]
 * @returns {object}
 */
function buildPostRotationPreviewTile(previewCanvas, expected, alignmentInfo, templateTile = null, targetSizeOverride = 0) {
  const canvas = document.createElement("canvas");
  const targetWidth = Math.max(1, targetSizeOverride || templateTile?.canvas?.width || 65);
  const targetHeight = Math.max(1, targetSizeOverride || templateTile?.canvas?.height || targetWidth);
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  canvas.style.width = `${targetWidth}px`;
  canvas.style.height = `${targetHeight}px`;
  const ctx = canvas.getContext("2d");
  const previewScaleX = previewCanvas.width / Math.max(1, alignmentInfo.rectifiedWidth || previewCanvas.width);
  const previewScaleY = previewCanvas.height / Math.max(1, alignmentInfo.rectifiedHeight || previewCanvas.height);
  // The page preview is already globally rotated. Sample it at the fixed unrotated tile center so
  // imagery slides/orbits through the aperture instead of appearing to spin each tile in place.
  const previewPoint = {
    x: expected.x * previewScaleX,
    y: expected.y * previewScaleY,
  };
  ctx.fillStyle = getPreviewCanvasBorderFillStyle(previewCanvas);
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const sourceWidth = Math.max(1, targetWidth * previewScaleX);
  const sourceHeight = Math.max(1, targetHeight * previewScaleY);
  const sourceX = previewPoint.x - (sourceWidth * 0.5);
  const sourceY = previewPoint.y - (sourceHeight * 0.5);
  ctx.filter = "grayscale(1)";
  ctx.drawImage(
    previewCanvas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    targetWidth,
    targetHeight,
  );
  ctx.filter = "none";
  return {
    ...(templateTile || {}),
    ...expected,
    kind: templateTile?.kind || "markerless",
    markerType: templateTile?.markerType || "markerless",
    roiCenterX: expected.x,
    roiCenterY: expected.y,
    detectedX: expected.x,
    detectedY: expected.y,
    dx: templateTile?.dx || 0,
    dy: templateTile?.dy || 0,
    darkFrac: templateTile?.darkFrac || 0,
    confidence: Number.isFinite(templateTile?.confidence) ? templateTile.confidence : 1,
    accepted: templateTile?.accepted ?? true,
    localX: (targetWidth - 1) * 0.5,
    localY: (targetHeight - 1) * 0.5,
    canvas,
    blobCanvas: null,
  };
}

/**
 * Build a display-only alignment view for the non-marker pipelines (markerless + per-frame) that
 * incorporates the current corner display offsets while leaving the stored coordinates unphased.
 *
 * Per-frame shares the markerless corner-tile display path so its Frame Corners panel renders the
 * same stabilized/nudged corner tiles. Only true marker mode short-circuits to the raw alignment
 * (or, while scrubbing post-rotation, the marker post-rotation preview tiles).
 *
 * @param {object | null} alignmentInfo
 * @returns {object | null}
 */
function getDisplayAlignmentInfo(alignmentInfo) {
  if (!alignmentInfo) return null;
  const config = readConfig();
  const showingPostRotationPreview = state.preview.postRotationScrubbing && !!state.preview.rectifiedCanvas;
  if (config.alignmentPipeline === "markers" && !showingPostRotationPreview) {
    return alignmentInfo;
  }
  const crossRoiScale = config.crossRoiScale;
  const previewCanvas = showingPostRotationPreview
    ? getPostRotationPreviewCanvas(state.preview.rectifiedCanvas, getPostRotationPreviewDeg())
    : null;

  if (config.alignmentPipeline === "markers") {
    const markerLookup = new Map(alignmentInfo.markerLookup);
    const crossRoiTiles = alignmentInfo.crossRoiTiles.map((tile) => buildPostRotationPreviewTile(
      previewCanvas,
      {
        col: tile.col,
        row: tile.row,
        x: Number.isFinite(tile.roiCenterX) ? tile.roiCenterX : tile.x,
        y: Number.isFinite(tile.roiCenterY) ? tile.roiCenterY : tile.y,
      },
      alignmentInfo,
      tile,
    ));
    return {
      ...alignmentInfo,
      markerLookup,
      crossRoiTiles,
      crossRoiTileMap: new Map(crossRoiTiles.map((tile) => [getMarkerKey(tile.col, tile.row), tile])),
    };
  }

  const markerLookup = new Map();
  const crossRoiTiles = [];
  const grayMat = previewCanvas ? null : ensureRectifiedGrayMat();
  if (!previewCanvas && !grayMat) return alignmentInfo;
  const markerlessPreviewTileSide = getMarkerlessCornerTileSidePx(alignmentInfo, crossRoiScale);

  for (let row = 0; row <= alignmentInfo.rows; row++) {
    for (let col = 0; col <= alignmentInfo.cols; col++) {
      const key = getMarkerKey(col, row);
      const sourceMarker = alignmentInfo.markerLookup.get(key);
      if (!sourceMarker) continue;
      const displayed = getMarkerlessDisplayedCorner(sourceMarker, col, row, alignmentInfo);
      const displayMarker = { ...sourceMarker, ...displayed };
      markerLookup.set(key, displayMarker);
      const sourceTile = alignmentInfo.crossRoiTileMap?.get(key) || null;
      const tile = previewCanvas
        ? buildPostRotationPreviewTile(
            previewCanvas,
            { col, row, x: displayMarker.roiCenterX, y: displayMarker.roiCenterY },
            alignmentInfo,
            sourceTile,
            markerlessPreviewTileSide,
          )
        : buildMarkerlessCornerTile(grayMat, {
            col,
            row,
            x: displayMarker.roiCenterX,
            y: displayMarker.roiCenterY,
          }, alignmentInfo, crossRoiScale);
      tile.detectedX = displayMarker.detectedX;
      tile.detectedY = displayMarker.detectedY;
      tile.autoDetectedX = displayMarker.autoDetectedX;
      tile.autoDetectedY = displayMarker.autoDetectedY;
      tile.manualOverride = state.geometry.manualMarkerOverrides.has(key);
      crossRoiTiles.push(tile);
    }
  }

  return {
    ...alignmentInfo,
    requestedMarkerType: "markerless",
    resolvedMarkerType: "markerless",
    markerLookup,
    crossRoiTiles,
    crossRoiTileMap: new Map(crossRoiTiles.map((tile) => [getMarkerKey(tile.col, tile.row), tile])),
  };
}

/**
 * @typedef {{
 *   scale:number,
 *   drawW:number,
 *   drawH:number,
 *   offsetX:number,
 *   offsetY:number,
 *   cssScaleX:number,
 *   cssScaleY:number,
 *   rect:DOMRect
 * }} RawImageLayout
 */

/**
 * Return a defensive copy of the active manual page-corner override, if any.
 *
 * @returns {{x:number,y:number}[] | null}
 */
function getManualPageContourForProcessing() {
  return Array.isArray(state.source.manualPageContour) && state.source.manualPageContour.length === 4
    ? state.source.manualPageContour.map((point) => ({ x: point.x, y: point.y }))
    : null;
}

/**
 * Identify whether a lightweight threshold preview still matches the current page-detection inputs.
 *
 * @param {ReturnType<typeof readConfig>} config
 * @returns {string}
 */
function getPageBoundaryPreviewSignature(config) {
  return [
    config.thresholdMethod,
    config.thresholdOffset,
    config.alignmentPipeline,
    config.lightOnDarkDesign ? "dark" : "light",
    state.source.canvas.width,
    state.source.canvas.height,
  ].join("|");
}

/**
 * Return the last live threshold-preview quad when it belongs to the current slider/config state.
 *
 * @param {ReturnType<typeof readConfig>} config
 * @returns {{x:number,y:number}[] | null}
 */
function getMatchingThresholdPreviewPageContour(config) {
  if (state.source.thresholdPreviewSignature !== getPageBoundaryPreviewSignature(config)) return null;
  return Array.isArray(state.source.thresholdPreviewPageContour) && state.source.thresholdPreviewPageContour.length === 4
    ? state.source.thresholdPreviewPageContour.map((point) => ({ x: point.x, y: point.y }))
    : null;
}

/**
 * Return whether enabling Page Corners overrides should create an editable placeholder page quad.
 *
 * @returns {boolean}
 */
function shouldSeedDefaultPageContour() {
  const hasDetectedContour = Array.isArray(state.source.rawPageContour) && state.source.rawPageContour.length === 4;
  const hasManualContour = Array.isArray(state.source.manualPageContour) && state.source.manualPageContour.length === 4;
  return !!state.runtime.pageBoundaryWarningVisible && !hasDetectedContour && !hasManualContour;
}

/**
 * Create a simple inset rectangle for images where no page boundary can be detected automatically.
 *
 * The inset is square in source-image pixels and based on the image diagonal, then clamped so
 * extreme aspect ratios still leave a usable rectangle.
 *
 * @returns {void}
 */
function seedDefaultManualPageContour() {
  const width = Math.max(1, Math.round(state.source.canvas?.width || 1));
  const height = Math.max(1, Math.round(state.source.canvas?.height || 1));
  const diagonalInset = Math.round(Math.hypot(width, height) * DEFAULT_PAGE_CORNER_INSET_DIAGONAL_FRACTION);
  const maxInset = Math.max(0, Math.floor((Math.min(width, height) - 2) * 0.45));
  const inset = Math.max(0, Math.min(diagonalInset, maxInset));
  const right = Math.max(inset + 1, width - 1 - inset);
  const bottom = Math.max(inset + 1, height - 1 - inset);
  const contour = [
    { x: inset, y: inset },
    { x: right, y: inset },
    { x: right, y: bottom },
    { x: inset, y: bottom },
  ];
  // Seeding a default editable quad is a manual override, so mirror it to the active image entry in
  // per-frame mode (legacy-only otherwise).
  setActiveManualPageContour(state, contour.map((point) => ({ x: point.x, y: point.y })), isPerFrameModeActive());
  state.source.rawPageContour = contour.map((point) => ({ x: point.x, y: point.y }));
  state.source.pageQuadSource = "manual-override";
  state.source.thresholdPreviewPageContour = null;
  state.source.thresholdPreviewSignature = "";
}

/**
 * Compute the fitted source-image rectangle inside the Page Corners canvas.
 *
 * @returns {RawImageLayout | null}
 */
function getRawImageLayout() {
  const targetCanvas = dom.rawCanvas;
  const sourceCanvas = state.source.canvas;
  if (!targetCanvas || !sourceCanvas?.width || !sourceCanvas?.height || !targetCanvas.width || !targetCanvas.height) {
    return null;
  }
  const rect = targetCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const scale = Math.min(targetCanvas.width / sourceCanvas.width, targetCanvas.height / sourceCanvas.height);
  const drawW = sourceCanvas.width * scale;
  const drawH = sourceCanvas.height * scale;
  return {
    scale,
    drawW,
    drawH,
    offsetX: (targetCanvas.width - drawW) * 0.5,
    offsetY: (targetCanvas.height - drawH) * 0.5,
    cssScaleX: rect.width / targetCanvas.width,
    cssScaleY: rect.height / targetCanvas.height,
    rect,
  };
}

/**
 * Convert a pointer event in the Page Corners canvas into source-image coordinates.
 *
 * @param {PointerEvent} event
 * @param {RawImageLayout} layout
 * @returns {{x:number,y:number}}
 */
function rawPointerEventToSourcePoint(event, layout) {
  const canvasX = (event.clientX - layout.rect.left) / layout.cssScaleX;
  const canvasY = (event.clientY - layout.rect.top) / layout.cssScaleY;
  const sourceCanvas = state.source.canvas;
  return {
    x: Math.max(0, Math.min(sourceCanvas.width - 1, (canvasX - layout.offsetX) / layout.scale)),
    y: Math.max(0, Math.min(sourceCanvas.height - 1, (canvasY - layout.offsetY) / layout.scale)),
  };
}

/**
 * Find the nearest displayed page corner within the Page Corners hit radius.
 *
 * @param {PointerEvent} event
 * @param {RawImageLayout} layout
 * @returns {number}
 */
function getNearestPageCornerIndex(event, layout) {
  const contour = state.source.rawPageContour;
  if (!Array.isArray(contour) || contour.length !== 4) return -1;
  const pointerXCss = event.clientX - layout.rect.left;
  const pointerYCss = event.clientY - layout.rect.top;
  let nearestIndex = -1;
  let nearestDist = PAGE_CORNER_HIT_RADIUS_CSS_PX;
  contour.forEach((point, index) => {
    const cornerXCss = (layout.offsetX + (point.x * layout.scale)) * layout.cssScaleX;
    const cornerYCss = (layout.offsetY + (point.y * layout.scale)) * layout.cssScaleY;
    const dist = Math.hypot(pointerXCss - cornerXCss, pointerYCss - cornerYCss);
    if (dist <= nearestDist) {
      nearestDist = dist;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

/**
 * Store an edited page corner as a manual override and mirror it to the rendered contour.
 *
 * @param {number} index
 * @param {{x:number,y:number}} point
 * @returns {void}
 */
function updateManualPageCorner(index, point) {
  const baseContour = (
    Array.isArray(state.source.manualPageContour) && state.source.manualPageContour.length === 4
      ? state.source.manualPageContour
      : state.source.rawPageContour
  );
  if (!Array.isArray(baseContour) || baseContour.length !== 4) return;
  const nextContour = baseContour.map((corner) => ({ x: corner.x, y: corner.y }));
  nextContour[index] = point;
  // In per-frame mode this also stores the override on the active image entry; in markers/markerless
  // it only writes the legacy field, exactly as before.
  setActiveManualPageContour(state, nextContour, isPerFrameModeActive());
  state.source.rawPageContour = nextContour.map((corner) => ({ x: corner.x, y: corner.y }));
  state.source.pageQuadSource = "manual-override";
}

/**
 * Stop stale downstream work immediately when the user starts editing the page quad.
 *
 * Page-corner overrides change the root rectification geometry, so old alignment, stabilization,
 * and frame-warmup work must not finish in the background and repopulate caches for the previous
 * page boundary.
 *
 * @returns {void}
 */
function cancelPageCornerOverrideDependentWork() {
  cancelInFlightProcessing();
  invalidateFrameCaches();
  state.frames.base = [];
  state.frames.baseOutputEpoch = [];
  state.geometry.frameCount = 0;
  state.geometry.alignmentInfo = null;
  state.preview.activeEditedMarker = null;
  state.runtime.markerEditingEnabled = false;
  syncMarkerEditingUi();
  updateExportControlsAvailability(true);
  updatePreviewPlayPauseButton();
}

/**
 * Attach Page Corners pointer handlers for editing existing page-corner detections.
 *
 * @returns {void}
 */
function attachRawPageCornerEditing() {
  dom.rawCanvas.addEventListener("pointerdown", (event) => {
    if (!state.runtime.pageCornerEditingEnabled || !state.source.image) return;
    const layout = getRawImageLayout();
    if (!layout) return;
    const cornerIndex = getNearestPageCornerIndex(event, layout);
    if (cornerIndex < 0) return;
    event.preventDefault();
    dom.rawCanvas.setPointerCapture?.(event.pointerId);
    cancelPageCornerOverrideDependentWork();
    state.preview.activePageCornerDrag = { pointerId: event.pointerId, cornerIndex };
    updateManualPageCorner(cornerIndex, rawPointerEventToSourcePoint(event, layout));
    syncPageCornerEditingUi();
    renderRawPreview();
  });

  dom.rawCanvas.addEventListener("pointermove", (event) => {
    const drag = state.preview.activePageCornerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const layout = getRawImageLayout();
    if (!layout) return;
    event.preventDefault();
    updateManualPageCorner(drag.cornerIndex, rawPointerEventToSourcePoint(event, layout));
    renderRawPreview();
  });

  const finishDrag = (event) => {
    const drag = state.preview.activePageCornerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (dom.rawCanvas.hasPointerCapture?.(event.pointerId)) {
      dom.rawCanvas.releasePointerCapture(event.pointerId);
    }
    state.preview.activePageCornerDrag = null;
    syncPageCornerEditingUi();
    renderRawPreview();
    revokeGifUrl();
    scheduleProcess();
  };

  dom.rawCanvas.addEventListener("pointerup", finishDrag);
  dom.rawCanvas.addEventListener("pointercancel", finishDrag);
}

/**
 * Switch the active per-frame image and redraw the raw photo, Page Corners overlay, and
 * Post-Rotation slider to match it — without rebuilding the rectified preview or animation.
 *
 * Active-image switching is UI navigation, not a config change: each image's page-corner override and
 * Post-Rotation are restored from its entry so the editor operates on the newly active image, but no
 * reprocessing is scheduled (the existing composite stays live until a real config change). In
 * markers / markerless modes there is at most one entry, so this just refreshes the raw preview.
 *
 * Until the Phase 7 image strip exists this is the supported active-image switch entry point (the
 * dev console can call `window.plottimation.setActiveImage(1)` or set
 * `state.source.activeImageIndex` and call `renderRawPreview()` directly).
 *
 * @param {number} index Zero-based image index (clamped to the loaded range).
 * @returns {void}
 */
function setActiveImage(index) {
  const entry = setActiveSourceImage(state, index);
  if (!entry) return;
  // Repoint the legacy projections at the newly active entry so every existing reader (raw preview,
  // Page Corners editor, drag/download, status) sees this image.
  if (entry.canvas) state.source.canvas = entry.canvas;
  if (entry.image) state.source.image = entry.image;
  state.source.filename = entry.filename || "";
  state.source.mimeType = entry.mimeType || "";
  state.source.dragUrl = entry.dragUrl || "";
  // Restore this image's manual page-corner override into the legacy field and the overlay contour.
  // A live threshold preview belongs to whichever image was last reprocessed, so drop it on switch.
  const contour = Array.isArray(entry.manualPageContour) && entry.manualPageContour.length === 4
    ? entry.manualPageContour.map((point) => ({ x: point.x, y: point.y }))
    : null;
  state.source.manualPageContour = contour;
  state.source.rawPageContour = contour ? contour.map((point) => ({ x: point.x, y: point.y })) : null;
  state.source.pageQuadSource = contour ? "manual-override" : "";
  state.source.thresholdPreviewPageContour = null;
  state.source.thresholdPreviewSignature = "";
  state.preview.activePageCornerDrag = null;
  // Restore this image's Post-Rotation onto the slider so the control reflects the active image.
  if (dom.postRotation) {
    dom.postRotation.value = String(Number.isFinite(entry.postRotationDeg) ? entry.postRotationDeg : 0);
    updateSliderReadouts();
  }
  syncRawPhotoHeadingLink();
  syncRawPhotoCreditDisplay();
  renderRawPreview();
  // Refresh the strip's active-thumbnail highlight to match the newly selected image.
  renderPerFrameStrip();
}

/**
 * Render the Page Corners preview and overlay the detected page quad in lime.
 *
 * @returns {void}
 */
function renderRawPreview() {
  updateMobileRawAspectRatio();
  renderCanvasFit(state.source.canvas, dom.rawCanvas);
  dom.rawCanvas.parentElement?.classList.remove("is-empty");
  syncPageCornerEditingUi();
  if (!state.source.rawPageContour || state.source.rawPageContour.length !== 4) return;
  const targetCanvas = dom.rawCanvas;
  const ctx = targetCanvas.getContext("2d");
  const layout = getRawImageLayout();
  if (!layout) return;
  ctx.save();
  ctx.strokeStyle = "rgba(0, 255, 0, 0.8)";
  ctx.lineWidth = getPanelOverlayStrokeWidth(3);
  ctx.beginPath();
  for (let i = 0; i < state.source.rawPageContour.length; i++) {
    const pt = state.source.rawPageContour[i];
    const x = layout.offsetX + (pt.x * layout.scale);
    const y = layout.offsetY + (pt.y * layout.scale);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
  if (state.runtime.pageCornerEditingEnabled) {
    drawRawPageCornerHandles(ctx, layout);
  }
  drawRawPageCornerMagnifier(ctx, layout);
  ctx.restore();
}

/**
 * Draw visible corner handles while Page Corners page-corner editing is enabled.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {RawImageLayout} layout
 * @returns {void}
 */
function drawRawPageCornerHandles(ctx, layout) {
  const radius = Math.max(4, PAGE_CORNER_HIT_RADIUS_CSS_PX / Math.max(layout.cssScaleX, layout.cssScaleY));
  ctx.save();
  state.source.rawPageContour.forEach((point, index) => {
    const x = layout.offsetX + (point.x * layout.scale);
    const y = layout.offsetY + (point.y * layout.scale);
    const isActive = state.preview.activePageCornerDrag?.cornerIndex === index;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? "rgba(0, 255, 0, 0.35)" : "rgba(0, 255, 0, 0.18)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.lineWidth = Math.max(1, getPanelOverlayStrokeWidth(1.5));
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

/**
 * Draw an opposite-quadrant magnified inset while the user drags a Page Corners page corner.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {RawImageLayout} layout
 * @returns {void}
 */
function drawRawPageCornerMagnifier(ctx, layout) {
  const drag = state.preview.activePageCornerDrag;
  const point = drag ? state.source.rawPageContour?.[drag.cornerIndex] : null;
  if (!point) return;
  const sourceCanvas = state.source.canvas;
  const baseInsetSize = Math.max(64, Math.min(layout.drawW, layout.drawH) / 3);
  const insetSize = baseInsetSize * PAGE_CORNER_MAGNIFIER_SIZE_SCALE;
  const margin = Math.max(8, 12 / Math.max(layout.cssScaleX, layout.cssScaleY));
  const insetX = point.x < sourceCanvas.width * 0.5
    ? layout.offsetX + layout.drawW - insetSize - margin
    : layout.offsetX + margin;
  const insetY = point.y < sourceCanvas.height * 0.5
    ? layout.offsetY + layout.drawH - insetSize - margin
    : layout.offsetY + margin;
  const sampleSize = Math.max(
    4,
    Math.min(sourceCanvas.width, sourceCanvas.height, baseInsetSize / (layout.scale * PAGE_CORNER_MAGNIFIER_SCALE))
  );
  const sampleLeft = point.x - (sampleSize * 0.5);
  const sampleTop = point.y - (sampleSize * 0.5);
  const visibleLeft = Math.max(0, sampleLeft);
  const visibleTop = Math.max(0, sampleTop);
  const visibleRight = Math.min(sourceCanvas.width, sampleLeft + sampleSize);
  const visibleBottom = Math.min(sourceCanvas.height, sampleTop + sampleSize);
  const visibleWidth = Math.max(0, visibleRight - visibleLeft);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  const magnifierScale = insetSize / sampleSize;
  const dx = insetX + ((visibleLeft - sampleLeft) * magnifierScale);
  const dy = insetY + ((visibleTop - sampleTop) * magnifierScale);

  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
  ctx.fillRect(insetX - 4, insetY - 4, insetSize + 8, insetSize + 8);
  ctx.save();
  ctx.beginPath();
  ctx.rect(insetX, insetY, insetSize, insetSize);
  ctx.clip();
  ctx.fillStyle = "rgba(32, 33, 36, 0.35)";
  ctx.fillRect(insetX, insetY, insetSize, insetSize);
  if (visibleWidth > 0 && visibleHeight > 0) {
    ctx.drawImage(
      sourceCanvas,
      visibleLeft,
      visibleTop,
      visibleWidth,
      visibleHeight,
      dx,
      dy,
      visibleWidth * magnifierScale,
      visibleHeight * magnifierScale
    );
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(0, 255, 0, 0.9)";
  ctx.lineWidth = Math.max(1, getPanelOverlayStrokeWidth(2));
  ctx.strokeRect(insetX, insetY, insetSize, insetSize);
  ctx.beginPath();
  ctx.moveTo(insetX + insetSize * 0.5, insetY);
  ctx.lineTo(insetX + insetSize * 0.5, insetY + insetSize);
  ctx.moveTo(insetX, insetY + insetSize * 0.5);
  ctx.lineTo(insetX + insetSize, insetY + insetSize * 0.5);
  ctx.stroke();
  ctx.restore();
}

/**
 * Rebuild the cross-region diagnostic grid from the latest alignment result.
 *
 * @param {object | null} alignmentInfo
 * @returns {void}
 */
function renderCrossRoiGrid(alignmentInfo) {
  const displayAlignmentInfo = getDisplayAlignmentInfo(alignmentInfo);
  renderCrossRoiGridViaEditor({
    dom,
    state,
    alignmentInfo: displayAlignmentInfo,
    getMarkerKey,
    syncMarkerEditingUi,
    onApplyOverride: applyMarkerOverride,
    onRestoreOverride: restoreMarkerOverride,
  });
  syncMobileMarkerGridLayout();
}

/**
 * Save or update one manual marker override in rectified-sheet coordinates and refresh dependent previews.
 *
 * @param {object} tile
 * @param {{x:number, y:number}} local
 * @param {boolean} finalize
 * @returns {void}
 */
function applyMarkerOverride(tile, local, finalize) {
  const center = (tile.canvas.width - 1) * 0.5;
  const roiCenterX = Number.isFinite(tile.roiCenterX) ? tile.roiCenterX : tile.x;
  const roiCenterY = Number.isFinite(tile.roiCenterY) ? tile.roiCenterY : tile.y;
  let detectedX = roiCenterX + (local.x - center);
  let detectedY = roiCenterY + (local.y - center);
  const config = readConfig();
  // Per-frame shares the markerless corner-nudge override model (stored as deltas from the displayed
  // corner), so both non-marker pipelines take the nudge path; only true marker mode stores absolute
  // detected positions and patches the marker objects in place.
  const usesCornerNudges = config.alignmentPipeline !== "markers";
  const key = getMarkerKey(tile.col, tile.row);
  if (usesCornerNudges && state.geometry.alignmentInfo) {
    const sourceMarker = state.geometry.alignmentInfo.markerLookup.get(key);
    if (sourceMarker) {
      const displayed = getMarkerlessDisplayedCorner(sourceMarker, tile.col, tile.row, state.geometry.alignmentInfo, false);
      state.geometry.manualMarkerOverrides.set(key, {
        x: detectedX - displayed.detectedX,
        y: detectedY - displayed.detectedY,
      });
    }
  } else {
    state.geometry.manualMarkerOverrides.set(key, { x: detectedX, y: detectedY });
  }
  state.preview.activeEditedMarker = finalize ? null : { col: tile.col, row: tile.row };
  if (state.geometry.alignmentInfo && !usesCornerNudges) {
    // Manual overrides patch the already-detected alignment object in place, which lets preview/extraction
    // update lazily from the edited marker positions without another CV pass.
    applyManualMarkerOverrides(state.geometry.alignmentInfo);
  }
  revokeGifUrl();
  if (!finalize) {
    if (usesCornerNudges) {
      beginMarkerOverrideScrub();
    } else {
      state.preview.markerOverrideScrubbing = true;
    }
  }
  let affectedMarkerFrames = null;
  if (usesCornerNudges && !finalize) {
    invalidateCurrentPreviewFrameForMarker(tile.col, tile.row);
  } else if (usesCornerNudges) {
    invalidateMarkerlessNudgedFramesForMarker(tile.col, tile.row);
  } else {
    affectedMarkerFrames = invalidateFramesForMarker(tile.col, tile.row);
  }
  syncMarkerEditingUi();
  if (finalize) {
    if (usesCornerNudges) {
      endMarkerOverrideScrub();
    } else {
      state.preview.markerOverrideScrubbing = false;
    }
    renderCrossRoiGrid(state.geometry.alignmentInfo);
    scheduleStabilizationPreviewUpdate();
    if (!usesCornerNudges) {
      if (affectedMarkerFrames) {
        scheduleCurrentPreviewFrameWarmupForSourceIndices(affectedMarkerFrames);
      } else {
        scheduleCurrentPreviewFrameWarmup();
      }
    }
    return;
  }
  scheduleStabilizationPreviewUpdate();
}

/**
 * Remove one saved marker override and restore the original auto-detected position.
 *
 * @param {object} tile
 * @returns {void}
 */
function restoreMarkerOverride(tile) {
  const key = getMarkerKey(tile.col, tile.row);
  state.geometry.manualMarkerOverrides.delete(key);
  state.preview.activeEditedMarker = null;
  // Non-marker pipelines (markerless + per-frame) clear corner-nudge overrides via cache
  // invalidation; only marker mode restores auto-detected positions on the live marker objects.
  const usesCornerNudges = readConfig().alignmentPipeline !== "markers";
  if (state.geometry.alignmentInfo && !usesCornerNudges) {
    const marker = state.geometry.alignmentInfo.markerLookup.get(key);
    const liveTile = state.geometry.alignmentInfo.crossRoiTileMap?.get(key);
    if (marker && Number.isFinite(marker.autoDetectedX)) {
      marker.detectedX = marker.autoDetectedX;
      marker.detectedY = marker.autoDetectedY;
      marker.manualOverride = false;
    }
    if (liveTile && Number.isFinite(liveTile.autoDetectedX)) {
      liveTile.detectedX = liveTile.autoDetectedX;
      liveTile.detectedY = liveTile.autoDetectedY;
      liveTile.manualOverride = false;
    }
  }
  revokeGifUrl();
  let affectedMarkerFrames = null;
  if (usesCornerNudges) {
    invalidateMarkerlessNudgedFramesForMarker(tile.col, tile.row);
  } else {
    affectedMarkerFrames = invalidateFramesForMarker(tile.col, tile.row);
  }
  syncMarkerEditingUi();
  renderCrossRoiGrid(state.geometry.alignmentInfo);
  scheduleStabilizationPreviewUpdate();
  if (!usesCornerNudges) {
    if (affectedMarkerFrames) {
      scheduleCurrentPreviewFrameWarmupForSourceIndices(affectedMarkerFrames);
    } else {
      scheduleCurrentPreviewFrameWarmup();
    }
  }
}

function makeSettingsFilename(sourceFilename) {
  return makeSettingsFilenameViaIo(sourceFilename, sanitizeFilenameBase);
}

/**
 * Serialize the current app settings into a simple tab-separated manifest.
 *
 * Each line uses:
 * `setting<TAB>value`
 *
 * @param {ReturnType<readConfig>} config
 * @returns {string}
 */
function buildSettingsTsv(config) {
  return buildSettingsTsvViaIo({
    config,
    sourceFilename: state.source.filename,
    sourceCredit: state.source.sourceCredit,
    manualMarkerOverrides: state.geometry.manualMarkerOverrides,
    manualPageContour: state.source.manualPageContour,
    // Per-frame mode persists one page-corner/post-rotation override set per uploaded image, keyed by
    // upload order. buildSettingsTsv only emits the indexed keys when config.alignmentPipeline is
    // "per-frame", so passing the entries unconditionally is harmless for markers/markerless saves.
    perImageEntries: state.source.images,
    sanitizeFilenameBase,
  });
}

function revokeGifUrl() {
  revokeGifUrlViaController({ dom, state, updateAnimationPreviewHeading });
}

/**
 * Materialize all adjusted frames and hand them off to the export controller's GIF encoder.
 *
 * @returns {Promise<void>}
 */
async function exportGif() {
  return exportGifViaController({
    dom,
    state,
    readConfig,
    getExportOrderedFrameCount,
    getExportOrderedFrameIndex,
    getAdjustedFrameCanvas,
    revokeGifUrl,
    updateAnimationPreviewHeading,
    updateExportControlsAvailability,
    setStatus,
  });
}

/**
 * Encode the ordered frame sequence as an H.264 MP4 using the export controller.
 *
 * @returns {Promise<void>}
 */
async function exportMp4() {
  return exportMp4ViaController({
    state,
    readConfig,
    getExportOrderedFrameCount,
    getExportOrderedFrameIndex,
    getAdjustedFrameCanvas,
    updateExportControlsAvailability,
    setStatus,
  });
}

/**
 * Export the current ordered animation frames as a ZIP archive of PNG files.
 *
 * @returns {Promise<void>}
 */
async function exportZip() {
  return exportZipViaController({
    state,
    readConfig,
    getExportOrderedFrameCount,
    getExportOrderedFrameIndex,
    getAdjustedFrameCanvas,
    buildSettingsTsv,
    makeSettingsFilename,
    updateExportControlsAvailability,
    setStatus,
    updateExportButtonLabel,
  });
}

/**
 * Download the current settings manifest as a standalone text file.
 *
 * @returns {void}
 */
function saveSettingsFile() {
  return saveSettingsFileViaController({
    state,
    readConfig,
    buildSettingsTsv,
    makeSettingsFilename,
  });
}

/**
 * Update the status panel text.
 *
 * Localized page-boundary failures should surface immediately even if the user had collapsed
 * Status, but only once an image is actually loaded.
 *
 * @param {string} text
 * @returns {void}
 */
function setStatus(text) {
  syncStatusText(dom, state, text);
  updateStabilizationProgressUi();
  updatePreviewFrameProgressUi();
  const hasLoadedImage = Boolean(state.source.filename || state.source.canvas);
  const showWarning = Boolean(state.runtime.pageBoundaryWarningVisible);
  if (hasLoadedImage && showWarning && dom.statusGroup) {
    dom.statusGroup.open = true;
  }
}
