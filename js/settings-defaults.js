/**
 * Canonical user-setting defaults.
 *
 * This module provides one source of truth for reset values and safe fallbacks when controls are
 * empty or invalid.
 */
/**
 * Central default values for user-facing settings.
 *
 * Keep this file in sync with the corresponding initial values in `index.html`.
 * The goal is to give `app.js` one canonical source for reset behavior and
 * fallback values when controls are empty or invalid.
 */
export const SETTINGS_DEFAULTS = {
  layout: {
    paperOrientation: "landscape",
    paperPreset: "letter",
    paperWidth: 11,
    paperHeight: 8.5,
    frameCols: 5,
    frameRows: 4,
  },
  detection: {
    alignmentPipeline: "markers",
    stabilizationMethod: "pairwise-cyclic",
    stabilizationEnabled: false,
    stabilizationStrengthPct: 100,
    thresholdMethod: "offset-peak",
    thresholdOffset: -20,
    lightOnDarkDesign: false,
    paperMarginXPx: 80,
    paperMarginYPx: 80,
    boundarySensitivity: 8.0,
    boundaryPersistencePx: 7,
    postRotationDeg: 0,
    alignmentMarkerType: "auto",
    crossRoiScalePct: 52,
    stabilizationLambda: 0.01,
    markerlessPhaseX: 0,
    markerlessPhaseY: 0,
    verticalDriftCompensation: 0,
    useCrossAlignment: true,
    detectCrossesWithConvolution: false,
  },
  appearance: {
    brightness: 0,
    contrast: 0,
    vibrance: 0,
    temperature: 0,
    unsharpAmount: 0,
    unsharpRadius: 1.0,
    invert: false,
  },
  cropGeometry: {
    cropLeft: 0,
    cropRight: 0,
    cropTop: 0,
    cropBottom: 0,
    flipHorizontal: false,
    flipVertical: false,
    rotate90Cw: false,
  },
  gifExport: {
    fps: 20,
    loopCount: 1,
    frameCountToExport: 0,
    reverseOrder: false,
    boustrophedonOrder: false,
    pingPong: false,
    outputWidthPx: 0,
    quality: 75,
    dither: "FloydSteinberg-serpentine",
    globalPalette: false,
  },
};

/**
 * Apply only the Appearance-panel defaults to the current DOM.
 *
 * @param {import("./dom-state.js").dom} dom
 * @returns {void}
 */
export function applyAppearanceDefaults(dom) {
  dom.brightness.value = String(SETTINGS_DEFAULTS.appearance.brightness);
  dom.contrast.value = String(SETTINGS_DEFAULTS.appearance.contrast);
  dom.vibrance.value = String(SETTINGS_DEFAULTS.appearance.vibrance);
  dom.temperature.value = String(SETTINGS_DEFAULTS.appearance.temperature);
  dom.unsharpAmount.value = String(SETTINGS_DEFAULTS.appearance.unsharpAmount);
  dom.unsharpRadius.value = SETTINGS_DEFAULTS.appearance.unsharpRadius.toFixed(1);
  dom.invert.checked = SETTINGS_DEFAULTS.appearance.invert;
}

/**
 * Apply only the Crop & Geometry defaults to the current DOM.
 *
 * @param {import("./dom-state.js").dom} dom
 * @returns {void}
 */
export function applyCropGeometryDefaults(dom) {
  dom.cropLeft.value = String(SETTINGS_DEFAULTS.cropGeometry.cropLeft);
  dom.cropRight.value = String(SETTINGS_DEFAULTS.cropGeometry.cropRight);
  dom.cropTop.value = String(SETTINGS_DEFAULTS.cropGeometry.cropTop);
  dom.cropBottom.value = String(SETTINGS_DEFAULTS.cropGeometry.cropBottom);
  dom.flipHorizontal.checked = SETTINGS_DEFAULTS.cropGeometry.flipHorizontal;
  dom.flipVertical.checked = SETTINGS_DEFAULTS.cropGeometry.flipVertical;
  dom.rotate90Cw.checked = SETTINGS_DEFAULTS.cropGeometry.rotate90Cw;
}

/**
 * Apply all non-Layout defaults to the current DOM.
 *
 * @param {import("./dom-state.js").dom} dom
 * @returns {void}
 */
export function applyNonLayoutDefaults(dom) {
  dom.alignmentPipelineMarkers.checked = SETTINGS_DEFAULTS.detection.alignmentPipeline === "markers";
  dom.alignmentPipelineMarkerless.checked = SETTINGS_DEFAULTS.detection.alignmentPipeline === "markerless";
  if (dom.alignmentPipelinePerFrame) {
    dom.alignmentPipelinePerFrame.checked = SETTINGS_DEFAULTS.detection.alignmentPipeline === "per-frame";
  }
  if (dom.stabilizationMethodPairwise) {
    dom.stabilizationMethodPairwise.checked = SETTINGS_DEFAULTS.detection.stabilizationMethod === "pairwise-cyclic";
  }
  if (dom.stabilizationMethodAverage) {
    dom.stabilizationMethodAverage.checked = SETTINGS_DEFAULTS.detection.stabilizationMethod === "difference-from-average";
  }
  if (dom.stabilizationEnabled) {
    dom.stabilizationEnabled.checked = SETTINGS_DEFAULTS.detection.stabilizationEnabled;
  }
  if (dom.stabilizationStrength) {
    dom.stabilizationStrength.value = String(SETTINGS_DEFAULTS.detection.stabilizationStrengthPct);
  }
  dom.thresholdMethod.value = SETTINGS_DEFAULTS.detection.thresholdMethod;
  dom.thresholdOffset.value = String(SETTINGS_DEFAULTS.detection.thresholdOffset);
  if (dom.lightOnDarkDesign) {
    dom.lightOnDarkDesign.checked = SETTINGS_DEFAULTS.detection.lightOnDarkDesign;
  }
  dom.paperMarginX.value = String(SETTINGS_DEFAULTS.detection.paperMarginXPx);
  dom.paperMarginY.value = String(SETTINGS_DEFAULTS.detection.paperMarginYPx);
  dom.boundarySensitivity.value = SETTINGS_DEFAULTS.detection.boundarySensitivity.toFixed(1);
  dom.boundaryPersistence.value = String(SETTINGS_DEFAULTS.detection.boundaryPersistencePx);
  if (dom.postRotation) {
    dom.postRotation.value = String(SETTINGS_DEFAULTS.detection.postRotationDeg);
  }
  dom.alignmentMarkerType.value = SETTINGS_DEFAULTS.detection.alignmentMarkerType;
  dom.crossRoiScale.value = String(SETTINGS_DEFAULTS.detection.crossRoiScalePct);
  dom.stabilizationLambda.value = SETTINGS_DEFAULTS.detection.stabilizationLambda.toFixed(3);
  dom.markerlessPhaseX.value = String(SETTINGS_DEFAULTS.detection.markerlessPhaseX);
  dom.markerlessPhaseY.value = String(SETTINGS_DEFAULTS.detection.markerlessPhaseY);
  if (dom.verticalDriftCompensation) {
    dom.verticalDriftCompensation.value = String(SETTINGS_DEFAULTS.detection.verticalDriftCompensation);
  }
  dom.useCrossAlignment.checked = SETTINGS_DEFAULTS.detection.useCrossAlignment;
  dom.detectCrossesWithConvolution.checked = SETTINGS_DEFAULTS.detection.detectCrossesWithConvolution;

  applyAppearanceDefaults(dom);
  applyCropGeometryDefaults(dom);

  dom.fps.value = String(SETTINGS_DEFAULTS.gifExport.fps);
  dom.loopCount.value = String(SETTINGS_DEFAULTS.gifExport.loopCount);
  if (dom.frameCountToExport) {
    dom.frameCountToExport.value = "";
  }
  dom.reverseOrder.checked = SETTINGS_DEFAULTS.gifExport.reverseOrder;
  dom.boustrophedonOrder.checked = SETTINGS_DEFAULTS.gifExport.boustrophedonOrder;
  dom.pingPong.checked = SETTINGS_DEFAULTS.gifExport.pingPong;
  dom.outputWidth.value = "";
  dom.outputHeight.value = "";
  dom.gifQuality.value = String(SETTINGS_DEFAULTS.gifExport.quality);
  dom.gifDither.value = SETTINGS_DEFAULTS.gifExport.dither;
  dom.gifGlobalPalette.checked = SETTINGS_DEFAULTS.gifExport.globalPalette;
}
