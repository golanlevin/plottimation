/**
 * Export-controller helpers.
 *
 * This module owns export-file naming, blob downloads, GIF/MP4/ZIP generation, and the small
 * bits of export UI state that are tightly coupled to those flows.
 */
import { createStoredZip } from "./zip-builder.js";
import { t } from "./i18n.js";

const MP4_MUXER_MODULE_URL = "./vendor/mp4-muxer.esm.js";
let mp4MuxerModulePromise = null;

/**
 * Set the Export GIF button label, optionally with an in-progress percentage suffix.
 *
 * @param {import("./dom-state.js").dom} dom
 * @param {number | null} [progressPercent=null]
 * @returns {void}
 */
export function updateExportButtonLabel(dom, progressPercent = null) {
  dom.exportButton.textContent = (typeof progressPercent === "number")
    ? t("export.exportGifProgress", { progress: progressPercent })
    : t("export.exportGif");
}

/**
 * Revoke and hide any previously exported GIF URL.
 *
 * @param {{
 *   dom: import("./dom-state.js").dom,
 *   state: import("./dom-state.js").state,
 *   updateAnimationPreviewHeading: () => void,
 * }} deps
 * @returns {void}
 */
export function revokeGifUrl({ dom, state, updateAnimationPreviewHeading }) {
  if (!state.export.url) return;
  URL.revokeObjectURL(state.export.url);
  state.export.url = "";
  state.export.filename = "";
  dom.gifPreviewCanvas.hidden = false;
  dom.gifImage.classList.add("hidden");
  dom.gifImage.hidden = true;
  dom.gifImage.removeAttribute("src");
  dom.gifPreviewCanvas.parentElement?.classList.add("is-empty");
  updateAnimationPreviewHeading();
}

/**
 * Strip unsupported characters from a filename stem.
 *
 * @param {string} filename
 * @returns {string}
 */
export function sanitizeFilenameBase(filename) {
  const withoutExt = filename.replace(/\.[^.]+$/, "");
  const cleaned = withoutExt.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "frame_sheet";
}

/**
 * Trigger a download for an in-memory blob with a caller-supplied filename.
 *
 * @param {Blob} blob
 * @param {string} filename
 * @returns {void}
 */
export function downloadBlobWithFilename(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Prefer the native mobile share sheet when available, otherwise fall back to a direct download.
 *
 * Browsers may reject `navigator.share()` if file sharing is unsupported or if transient user
 * activation has been lost during a long-running encode. In those cases, fall back to download so
 * export still succeeds.
 *
 * @param {Blob} blob
 * @param {string} filename
 * @param {string} mimeType
 * @param {boolean} preferShare
 * @returns {Promise<"shared" | "downloaded" | "canceled">}
 */
async function shareFileOrDownload(blob, filename, mimeType, preferShare) {
  if (preferShare && typeof File !== "undefined" && typeof navigator !== "undefined") {
    try {
      const file = new File([blob], filename, { type: mimeType });
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] }) && typeof navigator.share === "function") {
        await navigator.share({ files: [file], title: filename });
        return "shared";
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        return "canceled";
      }
      // Fall back to direct download below.
    }
  }

  downloadBlobWithFilename(blob, filename);
  return "downloaded";
}

/**
 * Build a timestamped archive stem shared by ZIP exports and other animation-file outputs.
 *
 * @param {string} sourceFilename
 * @param {number} [width=0]
 * @param {number} [height=0]
 * @returns {string}
 */
export function makeArchiveStem(sourceFilename, width = 0, height = 0) {
  const base = sanitizeFilenameBase(sourceFilename || "frame_sheet");
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const safeWidth = Math.max(1, Math.round(width || 0));
  const safeHeight = Math.max(1, Math.round(height || 0));
  const sizePart = (safeWidth > 0 && safeHeight > 0) ? `_${safeWidth}x${safeHeight}` : "";
  return `${base}_anim_${yy}${mm}${dd}${hh}${mi}${ss}${sizePart}`;
}

/**
 * Build a friendly exported GIF filename from the source name, compact timestamp, size, and quality.
 *
 * @param {string} sourceFilename
 * @param {number} [quality=75]
 * @param {number} [width=0]
 * @param {number} [height=0]
 * @returns {string}
 */
export function makeGifFilename(sourceFilename, quality = 75, width = 0, height = 0) {
  return `${makeArchiveStem(sourceFilename, width, height)}_q${quality}.gif`;
}

/**
 * Build an MP4 filename parallel to the GIF export naming scheme.
 *
 * @param {string} sourceFilename
 * @param {number} [quality=75]
 * @param {number} [width=0]
 * @param {number} [height=0]
 * @returns {string}
 */
export function makeMp4Filename(sourceFilename, quality = 75, width = 0, height = 0) {
  return `${makeArchiveStem(sourceFilename, width, height)}_q${quality}.mp4`;
}

/**
 * Build a ZIP filename for frame export.
 *
 * @param {string} sourceFilename
 * @param {number} [width=0]
 * @param {number} [height=0]
 * @returns {string}
 */
export function makeZipFilename(sourceFilename, width = 0, height = 0) {
  return `${makeArchiveStem(sourceFilename, width, height)}.zip`;
}

/**
 * Lazy-load the vendored mp4-muxer ESM module the first time MP4 export is requested.
 *
 * @returns {Promise<typeof import("./vendor/mp4-muxer.esm.js")>}
 */
function loadMp4MuxerModule() {
  if (!mp4MuxerModulePromise) {
    mp4MuxerModulePromise = import(MP4_MUXER_MODULE_URL);
  }
  return mp4MuxerModulePromise;
}

/**
 * Ensure tiny exported GIFs are still legible in the on-page preview panel.
 *
 * The file itself is unchanged; this only sets CSS display size for the previewed `<img>`.
 *
 * @param {import("./dom-state.js").dom} dom
 * @param {number} width
 * @param {number} height
 * @returns {void}
 */
function applyGifPreviewDisplaySize(dom, width, height) {
  const safeWidth = Math.max(1, Math.round(width || 1));
  const safeHeight = Math.max(1, Math.round(height || 1));
  const minDisplay = 32;
  if (Math.min(safeWidth, safeHeight) < minDisplay) {
    const scale = minDisplay / Math.min(safeWidth, safeHeight);
    dom.gifImage.style.width = `${Math.max(minDisplay, Math.round(safeWidth * scale))}px`;
    dom.gifImage.style.height = `${Math.max(minDisplay, Math.round(safeHeight * scale))}px`;
    return;
  }
  // Large previews should use intrinsic aspect ratio and fit naturally inside the panel.
  dom.gifImage.style.width = "";
  dom.gifImage.style.height = "";
}

/** Baseline-profile H.264 codec strings in ascending AVC level order. */
const H264_BASELINE_CODEC_LEVELS = [
  { maxCodedArea: 921_600, codec: "avc1.42001f" }, // Level 3.1 — up to ~1280×720 coded
  { maxCodedArea: 1_311_744, codec: "avc1.420020" }, // Level 3.2
  { maxCodedArea: 2_097_152, codec: "avc1.420028" }, // Level 4.0 — up to ~1920×1088 coded
  { maxCodedArea: 2_097_152, codec: "avc1.420029" }, // Level 4.1
  { maxCodedArea: 2_222_080, codec: "avc1.42002a" }, // Level 4.2
  { maxCodedArea: 5_670_400, codec: "avc1.420032" }, // Level 5.0
  { maxCodedArea: 9_437_184, codec: "avc1.420033" }, // Level 5.1
];

/** Legacy codec strings kept for browsers that reject the newer baseline level forms at probe time. */
const H264_LEGACY_CODEC_CANDIDATES = ["avc1.42E01E", "avc1.4D401E"];

/**
 * Return the H.264 coded-area size after 16×16 macroblock alignment.
 *
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
function getH264CodedArea(width, height) {
  const codedWidth = Math.ceil(width / 16) * 16;
  const codedHeight = Math.ceil(height / 16) * 16;
  return codedWidth * codedHeight;
}

/**
 * Return baseline-profile codec candidates whose AVC level can contain the coded area.
 *
 * @param {number} codedArea
 * @returns {string[]}
 */
function getBaselineCodecCandidatesForCodedArea(codedArea) {
  const firstSufficientIndex = H264_BASELINE_CODEC_LEVELS.findIndex((entry) => codedArea <= entry.maxCodedArea);
  if (firstSufficientIndex === -1) {
    return [H264_BASELINE_CODEC_LEVELS[H264_BASELINE_CODEC_LEVELS.length - 1].codec];
  }
  const candidates = [];
  for (let i = firstSufficientIndex; i < H264_BASELINE_CODEC_LEVELS.length; i++) {
    const codec = H264_BASELINE_CODEC_LEVELS[i].codec;
    if (!candidates.includes(codec)) {
      candidates.push(codec);
    }
  }
  return candidates;
}

/**
 * Probe whether the browser can encode one H.264 configuration with WebCodecs.
 *
 * @param {string} codec
 * @param {number} width
 * @param {number} height
 * @param {number} [fps=20]
 * @param {number} [bitrate=500_000]
 * @returns {Promise<boolean>}
 */
async function isMp4EncoderConfigSupported(codec, width, height, fps = 20, bitrate = 500_000) {
  if (typeof globalThis.VideoEncoder === "undefined" || typeof VideoEncoder.isConfigSupported !== "function") {
    return false;
  }
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      avc: { format: "avc" },
    });
    return !!support?.supported;
  } catch {
    return false;
  }
}

/**
 * Pick the lowest supported baseline H.264 codec that can encode the requested frame size.
 *
 * @param {number} width
 * @param {number} height
 * @param {{fps?:number, bitrate?:number}} [options]
 * @returns {Promise<string>}
 */
export async function resolveMp4Codec(width, height, options = {}) {
  const safeWidth = Math.max(1, Math.round(width || 1));
  const safeHeight = Math.max(1, Math.round(height || 1));
  const fps = options.fps ?? 20;
  const bitrate = options.bitrate ?? 500_000;
  const candidates = getBaselineCodecCandidatesForCodedArea(getH264CodedArea(safeWidth, safeHeight));
  for (const codec of candidates) {
    if (await isMp4EncoderConfigSupported(codec, safeWidth, safeHeight, fps, bitrate)) {
      return codec;
    }
  }
  return "";
}

/**
 * Probe whether this browser can encode H.264 frames with WebCodecs for later MP4 muxing.
 *
 * @returns {Promise<{supported:boolean, codec:string}>}
 */
export async function detectMp4ExportSupport() {
  if (typeof globalThis.VideoEncoder === "undefined" || typeof VideoEncoder.isConfigSupported !== "function") {
    return { supported: false, codec: "" };
  }
  const probeWidth = 640;
  const probeHeight = 480;
  const probeBitrate = 500_000;
  const probeFps = 20;
  const codec = await resolveMp4Codec(probeWidth, probeHeight, { fps: probeFps, bitrate: probeBitrate });
  if (codec) {
    return { supported: true, codec };
  }
  for (const legacyCodec of H264_LEGACY_CODEC_CANDIDATES) {
    if (await isMp4EncoderConfigSupported(legacyCodec, probeWidth, probeHeight, probeFps, probeBitrate)) {
      return { supported: true, codec: legacyCodec };
    }
  }
  return { supported: false, codec: "" };
}

/**
 * Estimate a target H.264 bitrate from dimensions, frame rate, and the shared quality slider.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @param {number} quality
 * @returns {number}
 */
function estimateMp4Bitrate(width, height, fps, quality) {
  const q = Math.max(0, Math.min(100, quality)) / 100;
  const bitsPerPixelPerFrame = 0.75 + (q * 3.25);
  return Math.max(500_000, Math.round(width * height * fps * bitsPerPixelPerFrame));
}

/**
 * Clamp MP4 export dimensions to be at least 16x16 and even-valued for H.264 friendliness.
 *
 * @param {HTMLCanvasElement | null} sourceCanvas
 * @returns {{width:number, height:number}}
 */
function getMp4ExportDimensions(sourceCanvas) {
  const safeWidth = Math.max(1, Math.round(sourceCanvas?.width || 1));
  const safeHeight = Math.max(1, Math.round(sourceCanvas?.height || 1));
  const minEdge = 16;
  const minCurrentEdge = Math.min(safeWidth, safeHeight);
  const scale = minCurrentEdge < minEdge ? (minEdge / minCurrentEdge) : 1;
  const evenize = (value) => {
    const rounded = Math.max(minEdge, Math.round(value));
    return (rounded % 2 === 0) ? rounded : (rounded + 1);
  };
  return {
    width: evenize(safeWidth * scale),
    height: evenize(safeHeight * scale),
  };
}

/**
 * Draw one prepared animation frame into the staging canvas used for MP4 encoding.
 *
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {HTMLCanvasElement} targetCanvas
 * @returns {void}
 */
function drawFrameIntoMp4Canvas(sourceCanvas, targetCanvas) {
  const ctx = targetCanvas.getContext("2d");
  ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, 0, 0, targetCanvas.width, targetCanvas.height);
}

/**
 * Encode a canvas as PNG bytes for ZIP frame export.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Uint8Array>}
 */
async function canvasToPngBytes(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    throw new Error("Could not encode PNG frame.");
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Materialize all adjusted frames and hand them off to gif.js for encoding.
 *
 * @param {{
 *   dom: import("./dom-state.js").dom,
 *   state: import("./dom-state.js").state,
 *   readConfig: () => any,
 *   getExportOrderedFrameCount: () => number,
 *   getExportOrderedFrameIndex: (index:number) => number,
 *   getAdjustedFrameCanvas: (index:number) => HTMLCanvasElement | null,
 *   revokeGifUrl: () => void,
 *   updateAnimationPreviewHeading: () => void,
 *   updateExportControlsAvailability: (forceDisabled?:boolean) => void,
 *   setStatus: (text:string) => void,
 * }} deps
 * @returns {Promise<void>}
 */
export async function exportGif(deps) {
  const {
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
  } = deps;
  const orderedFrameCount = getExportOrderedFrameCount();
  if (!orderedFrameCount) return;
  updateExportControlsAvailability(true);
  updateExportButtonLabel(dom, 0);
  setStatus(t("status.encodingGif"));

  const config = readConfig();
  const firstFrame = getAdjustedFrameCanvas(getExportOrderedFrameIndex(0));
  if (!firstFrame) {
    updateExportControlsAvailability();
    updateExportButtonLabel(dom);
    return;
  }

  const gif = new GIF({
    workers: 2,
    quality: config.exportOptions.quality,
    width: firstFrame.width,
    height: firstFrame.height,
    repeat: 0,
    dither: config.exportOptions.dither,
    globalPalette: config.exportOptions.globalPalette,
    workerScript: "js/vendor/gif.worker.js",
  });

  const delay = Math.max(1, Math.round(1000 / config.fps));
  for (let i = 0; i < orderedFrameCount; i++) {
    gif.addFrame(getAdjustedFrameCanvas(getExportOrderedFrameIndex(i)), { copy: true, delay });
  }

  gif.on("finished", (blob) => {
    revokeGifUrl();
    state.export.filename = makeGifFilename(
      state.source.filename,
      config.exportOptions.encodingQuality,
      firstFrame.width,
      firstFrame.height
    );
    state.export.url = URL.createObjectURL(blob);
    dom.gifImage.src = state.export.url;
    applyGifPreviewDisplaySize(dom, firstFrame.width, firstFrame.height);
    dom.gifPreviewCanvas.hidden = true;
    dom.gifImage.classList.remove("hidden");
    dom.gifImage.hidden = false;
    dom.gifPreviewCanvas.parentElement?.classList.remove("is-empty");
    updateAnimationPreviewHeading();
    updateExportControlsAvailability();
    updateExportButtonLabel(dom);
    void (async () => {
      const delivery = await shareFileOrDownload(
        blob,
        state.export.filename,
        "image/gif",
        !!state.runtime.mobileSingleViewerMode
      );
      if (delivery === "shared") {
        setStatus(t("status.gifReadyShared"));
      } else if (delivery === "canceled") {
        setStatus(t("status.gifReadyCanceled"));
      } else {
        setStatus(t("status.gifReadyFrameCount", { count: orderedFrameCount }));
      }
    })();
  });
  gif.on("progress", (progress) => {
    const progressPercent = Math.round(progress * 100);
    updateExportButtonLabel(dom, progressPercent);
    setStatus(t("status.encodingGifProgress", { progress: progressPercent }));
  });
  gif.render();
}

/**
 * Encode the ordered frame sequence as an H.264 MP4 using WebCodecs plus mp4-muxer.
 *
 * @param {{
 *   state: import("./dom-state.js").state,
 *   readConfig: () => any,
 *   getExportOrderedFrameCount: () => number,
 *   getExportOrderedFrameIndex: (index:number) => number,
 *   getAdjustedFrameCanvas: (index:number) => HTMLCanvasElement | null,
 *   updateExportControlsAvailability: (forceDisabled?:boolean) => void,
 *   setStatus: (text:string) => void,
 * }} deps
 * @returns {Promise<void>}
 */
export async function exportMp4(deps) {
  const {
    state,
    readConfig,
    getExportOrderedFrameCount,
    getExportOrderedFrameIndex,
    getAdjustedFrameCanvas,
    updateExportControlsAvailability,
    setStatus,
  } = deps;
  if (!state.runtime.mp4ExportSupported) return;
  const orderedFrameCount = getExportOrderedFrameCount();
  if (!orderedFrameCount) return;
  updateExportControlsAvailability(true);
  setStatus(t("status.encodingMp4"));

  const config = readConfig();
  const firstFrame = getAdjustedFrameCanvas(getExportOrderedFrameIndex(0));
  if (!firstFrame) {
    updateExportControlsAvailability();
    return;
  }

  const mp4Size = getMp4ExportDimensions(firstFrame);
  const encoderCanvas = document.createElement("canvas");
  encoderCanvas.width = mp4Size.width;
  encoderCanvas.height = mp4Size.height;
  drawFrameIntoMp4Canvas(firstFrame, encoderCanvas);

  try {
    const { Muxer, ArrayBufferTarget } = await loadMp4MuxerModule();
    const bitrate = estimateMp4Bitrate(mp4Size.width, mp4Size.height, config.fps, config.exportOptions.mp4Quality);
    const codec = await resolveMp4Codec(mp4Size.width, mp4Size.height, {
      fps: config.fps,
      bitrate,
    });
    if (!codec) {
      throw new Error(
        `No supported H.264 encoder configuration for ${mp4Size.width}x${mp4Size.height}. Try a smaller output size.`
      );
    }
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      fastStart: "in-memory",
      video: {
        codec: "avc",
        width: mp4Size.width,
        height: mp4Size.height,
      },
    });
    let encoderError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (error) => {
        encoderError = error;
      },
    });
    encoder.configure({
      codec,
      width: mp4Size.width,
      height: mp4Size.height,
      bitrate,
      framerate: config.fps,
      avc: { format: "avc" },
      latencyMode: "quality",
    });

    const frameDurationUs = Math.max(1, Math.round(1_000_000 / config.fps));
    const keyframeInterval = 2;
    for (let i = 0; i < orderedFrameCount; i++) {
      const frameCanvas = getAdjustedFrameCanvas(getExportOrderedFrameIndex(i));
      if (!frameCanvas) {
        throw new Error("Could not prepare one or more frames for MP4 export.");
      }
      drawFrameIntoMp4Canvas(frameCanvas, encoderCanvas);
      const timestampUs = i * frameDurationUs;
      const frame = new VideoFrame(encoderCanvas, {
        timestamp: timestampUs,
        duration: frameDurationUs,
      });
      encoder.encode(frame, { keyFrame: i === 0 || (i % keyframeInterval) === 0 });
      frame.close();
      if (encoderError) {
        throw encoderError;
      }
      setStatus(t("status.encodingMp4Progress", { progress: Math.round(((i + 1) / orderedFrameCount) * 100) }));
    }
    await encoder.flush();
    if (encoderError) {
      throw encoderError;
    }
    encoder.close();
    muxer.finalize();
    const mp4Blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
    const filename = makeMp4Filename(
      state.source.filename,
      config.exportOptions.encodingQuality,
      mp4Size.width,
      mp4Size.height
    );
    const delivery = await shareFileOrDownload(
      mp4Blob,
      filename,
      "video/mp4",
      !!state.runtime.mobileSingleViewerMode
    );
    if (delivery === "shared") {
      setStatus(t("status.mp4ReadyShared"));
    } else if (delivery === "canceled") {
      setStatus(t("status.mp4ReadyCanceled"));
    } else {
      setStatus(t("status.mp4ReadyFrameCount", { count: orderedFrameCount }));
    }
  } catch (error) {
    console.error(error);
    setStatus(t("status.mp4ExportFailed", { message: error?.message || String(error) }));
  } finally {
    updateExportControlsAvailability();
  }
}

/**
 * Export the current ordered animation frames as a ZIP archive of PNG files.
 *
 * @param {{
 *   state: import("./dom-state.js").state,
 *   readConfig: () => any,
 *   getExportOrderedFrameCount: () => number,
 *   getExportOrderedFrameIndex: (index:number) => number,
 *   getAdjustedFrameCanvas: (index:number) => HTMLCanvasElement | null,
 *   buildSettingsTsv: (config:any) => string,
 *   makeSettingsFilename: (sourceFilename:string) => string,
 *   updateExportControlsAvailability: (forceDisabled?:boolean) => void,
 *   setStatus: (text:string) => void,
 *   updateExportButtonLabel: () => void,
 * }} deps
 * @returns {Promise<void>}
 */
export async function exportZip(deps) {
  const {
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
  } = deps;
  const orderedFrameCount = getExportOrderedFrameCount();
  if (!orderedFrameCount) return;
  updateExportControlsAvailability(true);
  setStatus(t("status.preparingZip"));

  try {
    const config = readConfig();
    const base = sanitizeFilenameBase(state.source.filename || "frame_sheet");
    const archiveStem = makeArchiveStem(
      state.source.filename,
      config.exportOptions.outputWidthPx,
      config.exportOptions.outputHeightPx
    );
    const rootDir = `${archiveStem}/`;
    const framesDir = `${rootDir}frames/`;
    const settingsBytes = new TextEncoder().encode(buildSettingsTsv(config));
    const entries = [
      { name: rootDir, data: new Uint8Array(0), isDirectory: true },
      { name: framesDir, data: new Uint8Array(0), isDirectory: true },
      { name: `${rootDir}${makeSettingsFilename(state.source.filename)}`, data: settingsBytes },
    ];
    for (let i = 0; i < orderedFrameCount; i++) {
      const frameCanvas = getAdjustedFrameCanvas(getExportOrderedFrameIndex(i));
      if (!frameCanvas) {
        throw new Error("Could not prepare one or more frames for ZIP export.");
      }
      const pngBytes = await canvasToPngBytes(frameCanvas);
      const frameNumber = String(i).padStart(3, "0");
      entries.push({
        name: `${framesDir}${base}_anim_${frameNumber}.png`,
        data: pngBytes,
      });
    }

    const zipBlob = createStoredZip(entries);
    downloadBlobWithFilename(
      zipBlob,
      makeZipFilename(
        state.source.filename,
        config.exportOptions.outputWidthPx,
        config.exportOptions.outputHeightPx
      )
    );
    setStatus(t("status.zipReadyFrameCount", { count: orderedFrameCount }));
  } catch (error) {
    console.error(error);
    setStatus(t("status.zipExportFailed", { message: error?.message || String(error) }));
  } finally {
    updateExportControlsAvailability();
    updateExportButtonLabel();
  }
}

/**
 * Download the same settings manifest used inside ZIP export as a standalone text file.
 *
 * @param {{
 *   state: import("./dom-state.js").state,
 *   readConfig: () => any,
 *   buildSettingsTsv: (config:any) => string,
 *   makeSettingsFilename: (sourceFilename:string) => string,
 * }} deps
 * @returns {void}
 */
export function saveSettingsFile(deps) {
  const { state, readConfig, buildSettingsTsv, makeSettingsFilename } = deps;
  if (!state.geometry.frameCount) return;
  const config = readConfig();
  const settingsText = buildSettingsTsv(config);
  const blob = new Blob([settingsText], { type: "text/plain;charset=utf-8" });
  downloadBlobWithFilename(blob, makeSettingsFilename(state.source.filename));
}
