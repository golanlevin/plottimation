/**
 * UI event wiring helpers.
 *
 * This module attaches button, slider, checkbox, keyboard, and tooltip behavior so the main app
 * can supply callbacks without carrying the full DOM-listener implementation inline.
 */
import { t } from "./i18n.js";
import { attachPerFrameStrip } from "./per-frame-strip.js";

/**
 * Wire a small header reset button without toggling the parent details element.
 *
 * @param {HTMLButtonElement | null} button
 * @param {() => void} onReset
 * @returns {void}
 */
export function attachResetButton(button, onReset) {
  if (!button) return;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onReset();
  });
}

/**
 * Enable or disable native browser tooltips across the registered controls.
 *
 * @param {{
 *   dom: import("./dom-state.js").dom,
 *   state: import("./dom-state.js").state,
 *   enabled: boolean,
 *   previewTooltipText: string
 * }} deps
 * @returns {void}
 */
export function setTooltipsEnabled({ dom, state, enabled, previewTooltipText }) {
  state.runtime.tooltipsEnabled = enabled;
  for (const [element, text] of state.runtime.tooltipRegistry || []) {
    if (element === dom.exportMp4Button && !state.runtime.mp4ExportSupported) {
      element.title = t("panels.mp4Unsupported");
      continue;
    }
    if (enabled && String(text || "").trim()) {
      element.title = text;
    } else {
      element.removeAttribute("title");
    }
  }
  if (enabled && String(previewTooltipText || "").trim()) {
    dom.gifPreviewCanvas.title = previewTooltipText;
  } else {
    dom.gifPreviewCanvas.removeAttribute("title");
  }
  if (!state.runtime.mp4ExportSupported) {
    dom.exportMp4Button.title = t("panels.mp4Unsupported");
  }
  dom.tooltipToggleButton.textContent = enabled ? t("panels.disableTooltips") : t("panels.enableTooltips");
}

/**
 * Register tooltip text for major UI controls and keep them disabled by default.
 *
 * @param {{
 *   tooltipText: Record<string, string>,
 *   state: import("./dom-state.js").state,
 *   dom: import("./dom-state.js").dom,
 *   applyTooltipState: (enabled: boolean) => void
 * }} deps
 * @returns {void}
 */
export function initializeTooltips({ tooltipText, state, dom, applyTooltipState }) {
  const tooltipMap = new Map();
  for (const [selector, text] of Object.entries(tooltipText)) {
    document.querySelectorAll(selector).forEach((element) => {
      tooltipMap.set(element, text);
      const isFormControl = element.matches("input, select, textarea, output");
      if (isFormControl) {
        const label = element.closest("label");
        if (label) tooltipMap.set(label, text);
      }
    });
  }
  state.runtime.tooltipRegistry = [...tooltipMap.entries()];
  applyTooltipState(false);
}

/**
 * Wire the top-level marker/markerless pipeline switch.
 *
 * The listeners update labels/visibility on `input` so the UI feels immediate, then let the
 * normal processing path rerun because changing pipelines affects alignment semantics broadly.
 *
 * @param {{
 *   dom: import("./dom-state.js").dom,
 *   state: import("./dom-state.js").state,
 *   revokeGifUrl: () => void,
 *   updateSliderReadouts: () => void,
 *   scheduleProcess: (delayMs?: number) => void,
 *   syncAlignmentMarkerUi: () => void
 * }} deps
 * @returns {void}
 */
function attachAlignmentPipelineControls({
  dom,
  state,
  revokeGifUrl,
  updateSliderReadouts,
  scheduleProcess,
  syncAlignmentMarkerUi,
}) {
  const alignmentDom = dom.alignment;
  // The radio group is now the authoritative source of pipeline mode. A multi-image load set the
  // legacy `forcePerFrameMode` shim (and ticked the per-frame radio); once the user interacts with
  // the radio, reconcile the shim to the radio so switching *out* of per-frame actually sticks.
  const reconcilePerFrameForceFlag = () => {
    state.runtime.forcePerFrameMode = !!alignmentDom.alignmentPipelinePerFrame?.checked;
  };
  [
    alignmentDom.alignmentPipelineMarkerless,
    alignmentDom.alignmentPipelineMarkers,
    alignmentDom.alignmentPipelinePerFrame,
  ]
    .filter(Boolean)
    .forEach((input) => {
      input.addEventListener("input", () => {
        reconcilePerFrameForceFlag();
        syncAlignmentMarkerUi();
        revokeGifUrl();
        updateSliderReadouts();
        // Switching into per-frame mode before any images are uploaded must not process — there is
        // nothing to rectify yet. `scheduleProcess` already no-ops when `state.source.image` is null
        // (which is the empty-`images[]` case), so just wait for the upload to drive processing.
        scheduleProcess();
      });
      input.addEventListener("change", () => {
        reconcilePerFrameForceFlag();
        syncAlignmentMarkerUi();
        revokeGifUrl();
        scheduleProcess();
      });
    });
}

/**
 * Wire the markerless stabilization-method radio group.
 *
 * Switching methods invalidates different caches from the same frame set, so the handler warms
 * the newly selected path before clearing the busy cursor. That keeps the first stabilization
 * enable/preview from paying the full matcher setup cost on the interaction path.
 *
 * @param {{
 *   dom: import("./dom-state.js").dom,
 *   setGeometryProcessingCursor: (active: boolean) => void,
 *   revokeGifUrl: () => void,
 *   updateSliderReadouts: () => void,
 *   invalidateStabilizationCache: () => void,
 *   scheduleStabilizationPreviewUpdate: () => void,
 *   schedulePreviewFrameWarmup: () => void,
 *   syncAlignmentMarkerUi: () => void,
 *   warmCurrentStabilizationMethod: () => void
 * }} deps
 * @returns {void}
 */
function attachStabilizationMethodControls({
  dom,
  setGeometryProcessingCursor,
  revokeGifUrl,
  updateSliderReadouts,
  invalidateStabilizationCache,
  scheduleStabilizationPreviewUpdate,
  schedulePreviewFrameWarmup,
  syncAlignmentMarkerUi,
  warmCurrentStabilizationMethod,
}) {
  const alignmentDom = dom.alignment;
  [alignmentDom.stabilizationMethodPairwise, alignmentDom.stabilizationMethodAverage].forEach((input) => {
    if (!input) return;
    const applyMethodChange = () => {
      // Switching methods changes which stabilization caches are valid, so invalidate them
      // immediately. Only warm the new path when stabilization is actually enabled.
      syncAlignmentMarkerUi();
      revokeGifUrl();
      updateSliderReadouts();
      invalidateStabilizationCache();
      if (!alignmentDom.stabilizationEnabled?.checked) {
        scheduleStabilizationPreviewUpdate();
        schedulePreviewFrameWarmup();
        return;
      }
      setGeometryProcessingCursor(true);
      requestAnimationFrame(() => {
        try {
          warmCurrentStabilizationMethod();
          scheduleStabilizationPreviewUpdate();
          schedulePreviewFrameWarmup();
        } catch (error) {
          console.error(error);
        } finally {
          setGeometryProcessingCursor(false);
        }
      });
    };
    input.addEventListener("input", applyMethodChange);
    input.addEventListener("change", applyMethodChange);
  });
}

/**
 * Wire the marker-type selector used only by the marker pipeline.
 *
 * The helper intentionally skips reprocessing when the requested marker type merely matches the
 * already-resolved `Auto` result from the current alignment data.
 *
 * @param {{
 *   dom: import("./dom-state.js").dom,
 *   state: import("./dom-state.js").state,
 *   revokeGifUrl: () => void,
 *   updateSliderReadouts: () => void,
 *   scheduleProcess: (delayMs?: number) => void,
 *   syncAlignmentMarkerUi: () => void
 * }} deps
 * @returns {void}
 */
function attachAlignmentMarkerTypeControls({
  dom,
  state,
  revokeGifUrl,
  updateSliderReadouts,
  scheduleProcess,
  syncAlignmentMarkerUi,
}) {
  const alignmentDom = dom.alignment;
  const shouldSkipMarkerTypeReprocess = () => {
    if (alignmentDom.alignmentPipelineMarkerless.checked) return false;
    const requestedMarkerType = alignmentDom.alignmentMarkerType.value || "crosses";
    const lastAlignmentInfo = state.geometry.alignmentInfo;
    if (!lastAlignmentInfo) return false;
    return (
      requestedMarkerType !== "auto" &&
      lastAlignmentInfo.requestedMarkerType === "auto" &&
      lastAlignmentInfo.resolvedMarkerType === requestedMarkerType
    );
  };

  alignmentDom.alignmentMarkerType.addEventListener("input", () => {
    syncAlignmentMarkerUi();
    if (shouldSkipMarkerTypeReprocess()) return;
    revokeGifUrl();
    updateSliderReadouts();
    scheduleProcess();
  });
  alignmentDom.alignmentMarkerType.addEventListener("change", () => {
    syncAlignmentMarkerUi();
    if (shouldSkipMarkerTypeReprocess()) return;
    revokeGifUrl();
    scheduleProcess();
  });
}

/**
 * Wire `Grid Search Inset X/Y`.
 *
 * In markerless mode these sliders behave like scrubbed preview controls: dragging updates only
 * the rectified-sheet ROI overlay immediately, while the expensive reprocess waits until release.
 * In marker mode it stays a regular geometry-affecting control.
 *
 * @param {{
 *   dom: import("./dom-state.js").dom,
 *   state: import("./dom-state.js").state,
 *   beginMarkerlessPhaseScrub: () => void,
 *   endMarkerlessPhaseScrub: () => void,
 *   beginSearchInsetPreviewOverride: () => void,
 *   endSearchInsetPreviewOverride: () => void,
 *   revokeGifUrl: () => void,
 *   updateSliderReadouts: () => void,
 *   renderRectifiedPreview: (canvas: HTMLCanvasElement) => void,
 *   scheduleProcess: (delayMs?: number) => void
 * }} deps
 * @returns {void}
 */
function attachMarkerlessSearchInsetControls({
  dom,
  state,
  beginMarkerlessPhaseScrub,
  endMarkerlessPhaseScrub,
  beginSearchInsetPreviewOverride,
  endSearchInsetPreviewOverride,
  revokeGifUrl,
  updateSliderReadouts,
  renderRectifiedPreview,
  scheduleProcess,
}) {
  const alignmentDom = dom.alignment;
  const pageDetectionDom = dom.pageDetection;
  const isMarkerless = () => alignmentDom.alignmentPipelineMarkerless.checked;
  const searchInsetInputs = [
    pageDetectionDom.paperMarginX,
    pageDetectionDom.paperMarginY,
  ].filter(Boolean);
  const finishSearchInsetInteraction = () => {
    if (isMarkerless()) {
      endMarkerlessPhaseScrub();
    }
    endSearchInsetPreviewOverride();
  };

  searchInsetInputs.forEach((input) => {
    input.addEventListener("pointerdown", () => {
      beginSearchInsetPreviewOverride();
      if (!isMarkerless()) return;
      beginMarkerlessPhaseScrub();
    });
    input.addEventListener("pointerup", () => {
      finishSearchInsetInteraction();
    });
    input.addEventListener("pointercancel", () => {
      finishSearchInsetInteraction();
    });
    input.addEventListener("blur", () => {
      finishSearchInsetInteraction();
    });
    input.addEventListener("input", () => {
      revokeGifUrl();
      updateSliderReadouts();
      beginSearchInsetPreviewOverride();
      if (state.preview.rectifiedCanvas) {
        renderRectifiedPreview(state.preview.rectifiedCanvas);
      }
      if (isMarkerless()) {
        beginMarkerlessPhaseScrub();
        return;
      }
      scheduleProcess(700);
    });
    input.addEventListener("change", () => {
      revokeGifUrl();
      finishSearchInsetInteraction();
      scheduleProcess();
    });
  });
}

/**
 * Wire the markerless stabilization controls.
 *
 * `Enable Stabilization` gates whether the solved offsets are applied at all.
 * `Stabilization Strength` scales those already-solved offsets without restarting the solve.
 * `Rigidity` still scrubs against the pairwise solve path and invalidates only the offset solve.
 *
 * @param {{
 *   dom: import("./dom-state.js").dom,
 *   setGeometryProcessingCursor: (active:boolean) => void,
 *   beginStabilizationStrengthScrub: () => void,
 *   endStabilizationStrengthScrub: () => void,
 *   revokeGifUrl: () => void,
 *   updateSliderReadouts: () => void,
 *   invalidateCurrentPreviewStabilizationCaches: () => void,
 *   invalidateStabilizedOutputCaches: () => void,
 *   invalidateStabilizationOffsetsCache: () => void,
 *   scheduleStabilizationPreviewUpdate: () => void,
 *   schedulePreviewFrameWarmup: () => void,
 * }} deps
 * @returns {void}
 */
function attachStabilizationControls({
  dom,
  setGeometryProcessingCursor,
  beginStabilizationStrengthScrub,
  endStabilizationStrengthScrub,
  revokeGifUrl,
  updateSliderReadouts,
  invalidateCurrentPreviewStabilizationCaches,
  invalidateStabilizedOutputCaches,
  invalidateStabilizationOffsetsCache,
  scheduleStabilizationPreviewUpdate,
  schedulePreviewFrameWarmup,
}) {
  const alignmentDom = dom.alignment;
  if (alignmentDom.stabilizationEnabled) {
    alignmentDom.stabilizationEnabled.addEventListener("change", () => {
      setGeometryProcessingCursor(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            revokeGifUrl();
            updateSliderReadouts();
            invalidateStabilizedOutputCaches();
            scheduleStabilizationPreviewUpdate();
            schedulePreviewFrameWarmup();
          } finally {
            requestAnimationFrame(() => {
              setGeometryProcessingCursor(false);
            });
          }
        });
      });
    });
  }
  const bindSlider = (input, onChangeInvalidate) => {
    input.addEventListener("pointerdown", beginStabilizationStrengthScrub);
    input.addEventListener("pointerup", endStabilizationStrengthScrub);
    input.addEventListener("pointercancel", endStabilizationStrengthScrub);
    input.addEventListener("blur", endStabilizationStrengthScrub);
    input.addEventListener("input", () => {
      beginStabilizationStrengthScrub();
      revokeGifUrl();
      updateSliderReadouts();
      invalidateCurrentPreviewStabilizationCaches();
      scheduleStabilizationPreviewUpdate();
    });
    input.addEventListener("change", () => {
      revokeGifUrl();
      updateSliderReadouts();
      onChangeInvalidate();
      scheduleStabilizationPreviewUpdate();
      schedulePreviewFrameWarmup();
      endStabilizationStrengthScrub();
    });
  };

  if (alignmentDom.stabilizationStrength) {
    bindSlider(alignmentDom.stabilizationStrength, invalidateStabilizedOutputCaches);
  }
  bindSlider(alignmentDom.stabilizationLambda, invalidateStabilizationOffsetsCache);
}

/**
 * Wire the markerless post-lattice adjustment sliders.
 *
 * Dragging uses the fast current-frame path; release simply ends the scrub. The actual batch-wide
 * propagation now happens through the shared frame-output epoch in `app.js`, so every later frame
 * access observes the committed phase/drift without restarting stabilization.
 *
 * @param {{
 *   dom: import("./dom-state.js").dom,
 *   beginMarkerlessPhaseScrub: () => void,
 *   endMarkerlessPhaseScrub: () => void,
 *   bumpFrameOutputEpoch: () => void,
 *   revokeGifUrl: () => void,
 *   updateSliderReadouts: () => void,
 *   invalidateCurrentPreviewFrameCaches: () => void,
 *   scheduleMarkerlessPhasePreviewUpdate: () => void,
 *   schedulePreviewFrameWarmup: () => void,
 *   drawCurrentGifPreview: () => void
 * }} deps
 * @returns {void}
 */
function attachMarkerlessPhaseControls({
  dom,
  beginMarkerlessPhaseScrub,
  endMarkerlessPhaseScrub,
  bumpFrameOutputEpoch,
  revokeGifUrl,
  updateSliderReadouts,
  invalidateCurrentPreviewFrameCaches,
  scheduleMarkerlessPhasePreviewUpdate,
  schedulePreviewFrameWarmup,
  drawCurrentGifPreview,
}) {
  const alignmentDom = dom.alignment;
  [
    alignmentDom.markerlessPhaseX,
    alignmentDom.markerlessPhaseY,
    alignmentDom.verticalDriftCompensation,
  ].forEach((input) => {
    let releaseListenersAttached = false;
    const detachReleaseListeners = () => {
      if (!releaseListenersAttached) return;
      releaseListenersAttached = false;
      window.removeEventListener("pointerup", finishScrub, true);
      window.removeEventListener("pointercancel", finishScrub, true);
    };
    const attachReleaseListeners = () => {
      if (releaseListenersAttached) return;
      releaseListenersAttached = true;
      window.addEventListener("pointerup", finishScrub, true);
      window.addEventListener("pointercancel", finishScrub, true);
    };
    const finishScrub = () => {
      detachReleaseListeners();
      // Output caches now track a shared epoch, so phase/drift changes propagate lazily to every
      // frame without forcing an eager whole-batch rebuild on release.
      endMarkerlessPhaseScrub();
      drawCurrentGifPreview();
      schedulePreviewFrameWarmup();
    };
    input.addEventListener("pointerdown", () => {
      beginMarkerlessPhaseScrub();
      attachReleaseListeners();
    });
    input.addEventListener("blur", finishScrub);
    input.addEventListener("input", () => {
      beginMarkerlessPhaseScrub();
      bumpFrameOutputEpoch();
      revokeGifUrl();
      updateSliderReadouts();
      invalidateCurrentPreviewFrameCaches();
      scheduleMarkerlessPhasePreviewUpdate();
    });
    input.addEventListener("change", finishScrub);
  });
}

/**
 * Wire the temporary markerless gutter-metric toggles plus the shared light-on-dark switch.
 *
 * These switches change the lattice-estimation signals themselves, so they still require a full
 * processing rerun rather than any preview-only cache path.
 *
 * @param {{
 *   dom: import("./dom-state.js").dom,
 *   revokeGifUrl: () => void,
 *   scheduleProcess: (delayMs?: number) => void
 * }} deps
 * @returns {void}
 */
function attachMarkerlessPhaseMetricToggles({
  dom,
  revokeGifUrl,
  scheduleProcess,
}) {
  const alignmentDom = dom.alignment;
  const pageDetectionDom = dom.pageDetection;
  [
    alignmentDom.markerlessUseDarkness,
    alignmentDom.markerlessUseTexture,
    alignmentDom.markerlessUseVariance,
    pageDetectionDom.lightOnDarkDesign,
  ].forEach((input) => {
    if (!input) return;
    input.addEventListener("change", () => {
      revokeGifUrl();
      scheduleProcess();
    });
  });
}

/**
 * Wire the temporary markerless autocorrelation-blur slider.
 *
 * This changes the reduced working image used for both pitch and phase estimation, so it always
 * requires a full reprocess rather than a preview-only cache update.
 *
 * @param {{
 *   dom: import("./dom-state.js").dom,
 * Attach all DOM event listeners and classify controls by what they invalidate.
 *
 * @param {{
 *   dom: import("./dom-state.js").dom,
 *   state: import("./dom-state.js").state,
 *   makeCanvasDraggable: (canvas: HTMLCanvasElement, getDragAsset: () => any) => void,
 *   makeRectifiedFilename: (sourceFilename: string) => string,
 *   makeLivePreviewDragCue: () => void,
 *   makeGifImageDraggable: () => void,
 *   handleFile: (file: File, files?: FileList | File[] | null) => Promise<void>,
 *   loadSelectedDemo: (filename: string) => void,
 *   renderRectifiedPreview: (rectifiedCanvas: HTMLCanvasElement) => void,
 *   resetAppearanceControls: () => void,
 *   resetTrimControls: () => void,
 *   resetExportControls: () => void,
 *   toggleTooltips: () => void,
 *   togglePreviewPaused: () => void,
 *   stepPausedPreviewFrame: (direction: number) => void,
 *   toggleMarkerBlobView: () => void,
 *   toggleMarkerlessPhaseDebug: () => void,
 *   toggleMarkerlessWorkingImage: () => void,
 *   setRectifiedPreviewMode: (mode:"pre"|"post") => void,
 *   toggleMarkerEditing: () => void,
 *   clearMarkerEdits: () => void,
 *   syncOutputSizeFromWidthInput: () => void,
 *   syncOutputSizeFromHeightInput: () => void,
 *   swapManualOutputSizeForRotate90: () => void,
 *   previewPageBoundaryForThresholdOffset: () => void,
 *   syncPaperPresetUi: () => void,
 *   syncAlignmentMarkerUi: () => void,
 *   setActiveViewerTab: (view:string) => void,
 *   updateSliderReadouts: () => void,
 *   setGeometryProcessingCursor: (active:boolean) => void,
 *   scheduleProcess: () => void,
 *   revokeGifUrl: () => void,
 *   invalidateAppearanceCache: () => void,
 *   invalidateStabilizationCache: () => void,
 *   invalidateStabilizedOutputCaches: () => void,
 *   invalidateStabilizationOffsetsCache: () => void,
 *   invalidateCurrentPreviewFrameCaches: () => void,
 *   invalidateCurrentPreviewStabilizationCaches: () => void,
 *   scheduleAppearancePreviewUpdate: (includeRectified?: boolean) => void,
 *   scheduleStabilizationPreviewUpdate: () => void,
 *   scheduleMarkerlessPhasePreviewUpdate: () => void,
 *   schedulePostRotationPreviewUpdate: () => void,
 *   schedulePreviewFrameWarmup: () => void,
 *   runTimedHeavyPath: <T>(label:string, fn:() => T) => T,
 *   warmCurrentStabilizationMethod: () => void,
 *   beginStabilizationStrengthScrub: () => void,
 *   endStabilizationStrengthScrub: () => void,
 *   beginMarkerlessPhaseScrub: () => void,
 *   endMarkerlessPhaseScrub: () => void,
 *   beginSearchInsetPreviewOverride: () => void,
 *   endSearchInsetPreviewOverride: () => void,
 *   beginPostRotationScrub: () => void,
 *   endPostRotationScrub: () => void,
 *   finishPostRotationScrubIfUnchanged: () => boolean,
 *   commitActivePostRotationFromSlider: () => void,
 *   setActiveImage: (index:number) => void,
 *   isPerFrameModeActive: () => boolean,
 *   addPerFrameImages: (files: File[]) => Promise<void>,
 *   clearAllPreviews: () => void,
 *   bumpFrameOutputEpoch: () => void,
 *   setGeometryProcessingCursor: (active:boolean) => void,
 *   cancelInFlightProcessing: () => void,
 *   invalidateFrameCaches: () => void,
 *   invalidateFrameOutputCaches: () => void,
 *   rebuildAllFrameOutputCaches: () => void,
 *   drawCurrentGifPreview: () => void,
 *   exportGif: () => Promise<void>,
 *   exportMp4: () => Promise<void>,
 *   exportZip: () => Promise<void>,
 *   saveSettingsFile: () => void
 * }} deps
 * @returns {void}
 */
export function attachUi({
  dom,
  state,
  getPaperGeometrySignature,
  makeCanvasDraggable,
  makeRectifiedFilename,
  makeLivePreviewDragCue,
  makeGifImageDraggable,
  handleFile,
  loadSelectedDemo,
  renderRectifiedPreview,
  resetAppearanceControls,
  resetTrimControls,
  resetExportControls,
  toggleTooltips,
  togglePreviewPaused,
  stepPausedPreviewFrame,
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
  setGeometryProcessingCursor,
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
  schedulePreviewFrameWarmup,
  runTimedHeavyPath,
  warmCurrentStabilizationMethod,
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
  cancelInFlightProcessing,
  invalidateFrameCaches,
  invalidateFrameOutputCaches,
  rebuildAllFrameOutputCaches,
  drawCurrentGifPreview,
  exportGif,
  exportMp4,
  exportZip,
  saveSettingsFile,
}) {
  // Page Corners pointer gestures are reserved for direct page-corner editing.
  dom.rawCanvas.draggable = false;
  dom.rawCanvas.addEventListener("dragstart", (event) => {
    event.preventDefault();
  });

  makeCanvasDraggable(dom.rectifiedCanvas, () => {
    if (state.preview.rectifiedDragUrl) {
      return {
        url: state.preview.rectifiedDragUrl,
        filename: makeRectifiedFilename(state.source.filename),
        mimeType: "image/png",
      };
    }
    return {
      canvas: state.preview.rectifiedCanvas,
      filename: makeRectifiedFilename(state.source.filename),
      mimeType: "image/png",
    };
  });

  makeLivePreviewDragCue();
  makeGifImageDraggable();

  attachPerFrameStrip({
    dom,
    state,
    setActiveImage,
    reprocess: scheduleProcess,
    addImageFiles: addPerFrameImages,
    isPerFrameModeActive,
    clearPreviews: clearAllPreviews,
  });

  dom.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dom.dropZone.classList.add("dragging");
  });
  dom.dropZone.addEventListener("dragleave", () => {
    dom.dropZone.classList.remove("dragging");
  });
  const beginSourceLoadInteraction = (file, files = null) => {
    if (!file) return;
    document.body.classList.add("busy-loading");
    setGeometryProcessingCursor(true);
    requestAnimationFrame(() => {
      void (async () => {
        try {
          await handleFile(file, files);
        } finally {
          if (!state.runtime.busy) {
            document.body.classList.remove("busy-loading");
            setGeometryProcessingCursor(false);
          }
        }
      })();
    });
  };

  dom.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dom.dropZone.classList.remove("dragging");
    const file = event.dataTransfer?.files?.[0];
    beginSourceLoadInteraction(file, event.dataTransfer?.files || null);
  });
  dom.fileInput.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    beginSourceLoadInteraction(file, event.target.files || null);
  });
  dom.loadDemoSelect.addEventListener("change", () => {
    const filename = dom.loadDemoSelect.value;
    if (!filename) return;
    loadSelectedDemo(filename);
    dom.loadDemoSelect.value = "";
  });
  [dom.viewerTabRaw, dom.viewerTabRectified, dom.viewerTabMarkers, dom.viewerTabPreview].forEach((button) => {
    button?.addEventListener("click", () => {
      setActiveViewerTab(button.dataset.view || "preview");
    });
  });
  dom.rectifiedCanvas.addEventListener("click", () => {
    // Keep the convolution debug renderer available in code, but disable the direct canvas click
    // affordance for switching into that view.
  });
  [dom.rectifiedViewPre, dom.rectifiedViewPost].forEach((input) => {
    if (!input) return;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      setRectifiedPreviewMode(input.value === "post" ? "post" : "pre");
    });
  });

  attachResetButton(dom.resetAppearanceButton, resetAppearanceControls);
  attachResetButton(dom.resetTrimButton, resetTrimControls);
  attachResetButton(dom.resetExportButton, resetExportControls);
  dom.tooltipToggleButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleTooltips();
  });
  dom.previewPlayPauseButton.addEventListener("click", togglePreviewPaused);
  dom.toggleMarkerBlobViewButton?.addEventListener("click", toggleMarkerBlobView);
  dom.alignment.markerlessPhaseDebug?.addEventListener("change", () => {
    toggleMarkerlessPhaseDebug();
  });
  dom.toggleMarkerEditingButton.addEventListener("click", toggleMarkerEditing);
  dom.clearMarkerEditsButton.addEventListener("click", clearMarkerEdits);

  window.addEventListener("keydown", (event) => {
    const target = event.target;
    // Arrow-key scrubbing should not interfere with typing or with native select navigation,
    // but it should still work if a button currently holds focus.
    if (target instanceof HTMLElement && target.closest("input, textarea, select")) {
      return;
    }
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      togglePreviewPaused();
    } else if (event.key === "d" || event.key === "D") {
      event.preventDefault();
      toggleMarkerlessPhaseDebug();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepPausedPreviewFrame(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      stepPausedPreviewFrame(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      stepPausedPreviewFrame(-state.geometry.alignmentInfo?.cols || -1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      stepPausedPreviewFrame(state.geometry.alignmentInfo?.cols || 1);
    }
  });

  const maybeProcessPaperGeometryChange = () => {
    // Use the currently displayed width/height fields as the "before" snapshot. By the time these
    // events fire, the preset radio/select value has already changed, so `readConfig()` would see
    // the new preset too early and incorrectly conclude that nothing changed.
    const before = `${String(dom.paperWidth.value || "").trim()}x${String(dom.paperHeight.value || "").trim()}`;
    syncPaperPresetUi();
    updateSliderReadouts();
    const after = `${String(dom.paperWidth.value || "").trim()}x${String(dom.paperHeight.value || "").trim()}`;
    if (before !== after) {
      // Large scans can make paper-geometry reprocessing expensive. Use a longer debounce here so
      // quick preset/orientation sequences like "Tabloid, then Portrait" collapse into one run.
      scheduleProcess(480);
    }
  };

  dom.paperPreset.addEventListener("change", () => {
    maybeProcessPaperGeometryChange();
  });
  [dom.paperOrientationLandscape, dom.paperOrientationPortrait].forEach((input) => {
    input.addEventListener("change", () => {
      maybeProcessPaperGeometryChange();
    });
  });

  attachAlignmentPipelineControls({
    dom,
    state,
    revokeGifUrl,
    updateSliderReadouts,
    scheduleProcess,
    syncAlignmentMarkerUi,
  });
  attachStabilizationMethodControls({
    dom,
    setGeometryProcessingCursor,
    revokeGifUrl,
    updateSliderReadouts,
    invalidateStabilizationCache,
    scheduleStabilizationPreviewUpdate,
    schedulePreviewFrameWarmup,
    syncAlignmentMarkerUi,
    warmCurrentStabilizationMethod,
  });
  attachAlignmentMarkerTypeControls({
    dom,
    state,
    revokeGifUrl,
    updateSliderReadouts,
    scheduleProcess,
    syncAlignmentMarkerUi,
  });

  const appearanceInputs = [
    dom.brightness,
    dom.contrast,
    dom.vibrance,
    dom.temperature,
    dom.unsharpRadius,
    dom.unsharpAmount,
    dom.invert
  ];
  appearanceInputs.forEach((input) => {
    input.addEventListener("input", () => {
      revokeGifUrl();
      updateSliderReadouts();
      invalidateAppearanceCache();
      scheduleAppearancePreviewUpdate(false);
      cancelInFlightProcessing();
    });
    input.addEventListener("change", () => {
      revokeGifUrl();
      updateSliderReadouts();
      invalidateAppearanceCache();
      scheduleAppearancePreviewUpdate(false);
    });
  });

  const geometryInputs = [
    dom.paperWidth,
    dom.paperHeight,
    dom.frameCols,
    dom.frameRows,
    dom.thresholdMethod,
    dom.boundarySensitivity,
    dom.boundaryPersistence,
    dom.detectCrossesWithConvolution,
    dom.useCrossAlignment,
  ];
  geometryInputs.forEach((input) => {
    input.addEventListener("input", () => {
      revokeGifUrl();
      updateSliderReadouts();
      if (input === dom.paperWidth || input === dom.paperHeight) {
        scheduleProcess(380);
      } else {
        scheduleProcess();
      }
    });
    input.addEventListener("change", () => {
      revokeGifUrl();
      if (input === dom.paperWidth || input === dom.paperHeight) {
        scheduleProcess(0);
      } else {
        scheduleProcess();
      }
    });
  });

  [dom.paperWidth, dom.paperHeight].forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      revokeGifUrl();
      updateSliderReadouts();
      scheduleProcess(0);
    });
  });

  attachMarkerlessSearchInsetControls({
    dom,
    state,
    beginMarkerlessPhaseScrub,
    endMarkerlessPhaseScrub,
    beginSearchInsetPreviewOverride,
    endSearchInsetPreviewOverride,
    revokeGifUrl,
    updateSliderReadouts,
    renderRectifiedPreview,
    scheduleProcess,
  });

  dom.crossRoiScale.addEventListener("input", () => {
    updateSliderReadouts();
  });
  dom.crossRoiScale.addEventListener("change", () => {
    revokeGifUrl();
    updateSliderReadouts();
    scheduleProcess();
  });

  attachStabilizationControls({
    dom,
    setGeometryProcessingCursor,
    beginStabilizationStrengthScrub,
    endStabilizationStrengthScrub,
    revokeGifUrl,
    updateSliderReadouts,
    invalidateCurrentPreviewStabilizationCaches,
    invalidateStabilizedOutputCaches,
    invalidateStabilizationOffsetsCache,
    scheduleStabilizationPreviewUpdate,
    schedulePreviewFrameWarmup,
  });
  attachMarkerlessPhaseControls({
    dom,
    beginMarkerlessPhaseScrub,
    endMarkerlessPhaseScrub,
    bumpFrameOutputEpoch,
    revokeGifUrl,
    updateSliderReadouts,
    invalidateCurrentPreviewFrameCaches,
    scheduleMarkerlessPhasePreviewUpdate,
    schedulePreviewFrameWarmup,
    drawCurrentGifPreview,
  });
  attachMarkerlessPhaseMetricToggles({
    dom,
    revokeGifUrl,
    scheduleProcess,
  });

  dom.thresholdOffset.addEventListener("input", () => {
    // While the slider is dragged, update only the readout plus the lightweight Page Corners page-quad
    // preview. The full pipeline still waits for the `change` event on release.
    updateSliderReadouts();
    previewPageBoundaryForThresholdOffset();
  });
  dom.thresholdOffset.addEventListener("change", () => {
    revokeGifUrl();
    updateSliderReadouts();
    scheduleProcess();
  });
  if (dom.postRotation) {
    dom.postRotation.addEventListener("pointerdown", beginPostRotationScrub);
    dom.postRotation.addEventListener("pointerup", () => {
      finishPostRotationScrubIfUnchanged();
    });
    dom.postRotation.addEventListener("pointercancel", () => {
      finishPostRotationScrubIfUnchanged();
    });
    dom.postRotation.addEventListener("blur", () => {
      finishPostRotationScrubIfUnchanged();
    });
    dom.postRotation.addEventListener("input", () => {
      revokeGifUrl();
      beginPostRotationScrub();
      updateSliderReadouts();
      schedulePostRotationPreviewUpdate();
    });
    dom.postRotation.addEventListener("change", () => {
      revokeGifUrl();
      updateSliderReadouts();
      if (finishPostRotationScrubIfUnchanged()) return;
      // Per-frame mode stores Post-Rotation per image, so persist the slider value onto the active
      // image before reprocessing. No-op (and unchanged behavior) in markers / markerless mode.
      commitActivePostRotationFromSlider?.();
      scheduleProcess();
    });
  }

  const lazyFrameInputs = [
    dom.gifResampling,
    dom.outputWidth,
    dom.outputHeight,
    dom.cropLeft,
    dom.cropRight,
    dom.cropTop,
    dom.cropBottom,
    dom.flipHorizontal,
    dom.flipVertical,
    dom.rotate90Cw,
    dom.fps,
    dom.loopCount,
    dom.frameCountToExport,
    dom.gifQuality,
    dom.gifDither,
    dom.gifGlobalPalette,
    dom.reverseOrder,
    dom.boustrophedonOrder,
    dom.pingPong
  ];
  const requiresFrameCacheRebuild = (input) => (
    (input === dom.gifResampling) ||
    (input === dom.outputWidth) ||
    (input === dom.outputHeight) ||
    (input === dom.cropLeft) ||
    (input === dom.cropRight) ||
    (input === dom.cropTop) ||
    (input === dom.cropBottom) ||
    (input === dom.flipHorizontal) ||
    (input === dom.flipVertical) ||
    (input === dom.rotate90Cw)
  );
  const usesLazyOutputEpochUpdate = (input) => (
    (input === dom.flipHorizontal) ||
    (input === dom.flipVertical) ||
    (input === dom.rotate90Cw)
  );
  const applyLazyFrameUpdate = (input, { showBusyCursor = false } = {}) => {
    if (input === dom.outputWidth) syncOutputSizeFromWidthInput();
    if (input === dom.outputHeight) syncOutputSizeFromHeightInput();
    revokeGifUrl();
    if (usesLazyOutputEpochUpdate(input)) {
      bumpFrameOutputEpoch();
      invalidateCurrentPreviewFrameCaches();
      runTimedHeavyPath("Heavy path: preview-redraw", () => {
        drawCurrentGifPreview();
      });
      schedulePreviewFrameWarmup();
      return;
    }
    const redraw = () => {
      const label = requiresFrameCacheRebuild(input)
        ? "Heavy path: frame-cache-rebuild"
        : "Heavy path: preview-redraw";
      runTimedHeavyPath(label, () => {
        if (requiresFrameCacheRebuild(input)) rebuildAllFrameOutputCaches();
        drawCurrentGifPreview();
      });
      if (!requiresFrameCacheRebuild(input)) {
        schedulePreviewFrameWarmup();
      }
    };
    if (!showBusyCursor) {
      redraw();
      return;
    }
    setGeometryProcessingCursor(true);
    if (dom.previewBusy) {
      dom.previewBusy.hidden = false;
    }
    requestAnimationFrame(() => {
      try {
        redraw();
      } catch (error) {
        console.error(error);
      } finally {
        setGeometryProcessingCursor(false);
        if (dom.previewBusy && !document.body.classList.contains("busy-loading")) {
          dom.previewBusy.hidden = true;
        }
      }
    });
  };
  const cropInputDebounceMs = 320;
  const outputSizeInputDebounceMs = 380;
  const lazyInputTimers = new WeakMap();
  const lazyInputLastAppliedValues = new WeakMap();
  const isCropField = (input) => (
    input === dom.cropLeft ||
    input === dom.cropRight ||
    input === dom.cropTop ||
    input === dom.cropBottom
  );
  const isOutputSizeField = (input) => (
    input === dom.outputWidth ||
    input === dom.outputHeight
  );
  const getLazyInputValue = (input) => {
    if (input instanceof HTMLInputElement && input.type === "checkbox") {
      return input.checked ? "true" : "false";
    }
    return String(input?.value ?? "");
  };
  const shouldShowBusyCursorForLazyInput = (input) => (
    input === dom.gifResampling || isCropField(input) || isOutputSizeField(input)
  );
  const hasLazyInputValueChanged = (input) => (
    getLazyInputValue(input) !== lazyInputLastAppliedValues.get(input)
  );
  const flushLazyFrameUpdate = (input) => {
    const existingTimer = lazyInputTimers.get(input);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
      lazyInputTimers.delete(input);
    }
    if (!hasLazyInputValueChanged(input)) return;
    applyLazyFrameUpdate(input, { showBusyCursor: shouldShowBusyCursorForLazyInput(input) });
    lazyInputLastAppliedValues.set(input, getLazyInputValue(input));
  };
  const scheduleLazyFrameUpdate = (input) => {
    if (!hasLazyInputValueChanged(input)) {
      const existingTimer = lazyInputTimers.get(input);
      if (existingTimer) {
        window.clearTimeout(existingTimer);
        lazyInputTimers.delete(input);
      }
      return;
    }
    if (!isCropField(input) && !isOutputSizeField(input)) {
      applyLazyFrameUpdate(input, { showBusyCursor: shouldShowBusyCursorForLazyInput(input) });
      lazyInputLastAppliedValues.set(input, getLazyInputValue(input));
      return;
    }
    const existingTimer = lazyInputTimers.get(input);
    if (existingTimer) window.clearTimeout(existingTimer);
    const timerId = window.setTimeout(() => {
      lazyInputTimers.delete(input);
      applyLazyFrameUpdate(input, { showBusyCursor: shouldShowBusyCursorForLazyInput(input) });
      lazyInputLastAppliedValues.set(input, getLazyInputValue(input));
    }, isOutputSizeField(input) ? outputSizeInputDebounceMs : cropInputDebounceMs);
    lazyInputTimers.set(input, timerId);
  };
  lazyFrameInputs.forEach((input) => {
    lazyInputLastAppliedValues.set(input, getLazyInputValue(input));
    input.addEventListener("focus", () => {
      if (!isCropField(input) && !isOutputSizeField(input)) return;
      // Crop fields are often updated programmatically during image/settings load. Treat the value
      // seen on focus as the current committed baseline so merely clicking into the field does not
      // flush a stale "changed" state from earlier setup work. Output-size fields use the same
      // protection because they are also rewritten programmatically during settings/UI sync.
      lazyInputLastAppliedValues.set(input, getLazyInputValue(input));
    });
    input.addEventListener("input", () => {
      if (isOutputSizeField(input)) {
        if (input === dom.outputWidth) syncOutputSizeFromWidthInput();
        if (input === dom.outputHeight) syncOutputSizeFromHeightInput();
        updateSliderReadouts();
        scheduleLazyFrameUpdate(input);
        return;
      }
      if (input === dom.rotate90Cw && hasLazyInputValueChanged(input)) {
        swapManualOutputSizeForRotate90();
      }
      updateSliderReadouts();
      if (input === dom.rotate90Cw) {
        lazyInputLastAppliedValues.set(dom.outputWidth, getLazyInputValue(dom.outputWidth));
        lazyInputLastAppliedValues.set(dom.outputHeight, getLazyInputValue(dom.outputHeight));
      }
      scheduleLazyFrameUpdate(input);
    });
    input.addEventListener("change", () => {
      if (isOutputSizeField(input)) {
        if (input === dom.outputWidth) syncOutputSizeFromWidthInput();
        if (input === dom.outputHeight) syncOutputSizeFromHeightInput();
        updateSliderReadouts();
        flushLazyFrameUpdate(input);
        return;
      }
      if (input === dom.rotate90Cw && hasLazyInputValueChanged(input)) {
        swapManualOutputSizeForRotate90();
      }
      updateSliderReadouts();
      if (input === dom.rotate90Cw) {
        lazyInputLastAppliedValues.set(dom.outputWidth, getLazyInputValue(dom.outputWidth));
        lazyInputLastAppliedValues.set(dom.outputHeight, getLazyInputValue(dom.outputHeight));
      }
      scheduleLazyFrameUpdate(input);
    });
    input.addEventListener("blur", () => {
      if (!isCropField(input) && !isOutputSizeField(input)) return;
      flushLazyFrameUpdate(input);
    });
    input.addEventListener("keydown", (event) => {
      if (!isCropField(input) && !isOutputSizeField(input)) return;
      if (event.key !== "Enter" && event.key !== "Return") return;
      flushLazyFrameUpdate(input);
    });
  });

  dom.exportButton.addEventListener("click", () => {
    void exportGif();
  });
  dom.exportMp4Button.addEventListener("click", () => {
    void exportMp4();
  });
  dom.exportZipButton.addEventListener("click", () => {
    void exportZip();
  });
  dom.saveSettingsButton.addEventListener("click", saveSettingsFile);
}
