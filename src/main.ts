import { createSeededNoise } from "./noise";
import { generateTerrain, TerrainMap, TerrainCell } from "./terrain";
import { GEOLOGY_INFO } from "./geology";
import {
  renderTerrainToBuffer,
  bakeVegetationNoise,
  renderViewport,
  renderHighResViewport,
  renderLegend,
  canvasToTerrain,
  Viewport,
} from "./renderer";

// --- State ---
let currentTerrain: TerrainMap | null = null;
let currentBuffer: ImageData | null = null;
let viewport: Viewport = { cx: 150, cy: 250, zoom: 1 };
let showVegetation = false;

// --- High-res patch cache (buffer only — terrain lives in the worker) ---
interface HighResCache {
  tier: 2 | 3;
  resScale: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  buffer: ImageData;
}
let highResCache: HighResCache | null = null;

// --- Patch worker ---
const patchWorker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let workerReady = false;
let pendingRequestId = 0;
/** Coarse bounds of the patch currently being computed in the worker. */
let pendingBounds: { x0: number; y0: number; x1: number; y1: number } | null = null;

type WorkerResponse =
  | { type: "ready" }
  | { type: "notReady"; requestId: number }
  | { type: "patch"; rawBuffer: ArrayBuffer; width: number; height: number;
      x0: number; y0: number; x1: number; y1: number;
      resScale: number; tier: 2 | 3; requestId: number };

patchWorker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;

  if (msg.type === "ready") {
    workerReady = true;
    // If we're already zoomed in and waiting, trigger a patch request now.
    if (getZoomTier(viewport.zoom) > 1 && !highResCache) render();

  } else if (msg.type === "notReady") {
    // Worker wasn't ready; it will send "ready" soon, which triggers render().

  } else if (msg.type === "patch") {
    if (msg.requestId !== pendingRequestId) return; // stale result — discard
    pendingBounds = null;
    const imageData = new ImageData(
      new Uint8ClampedArray(msg.rawBuffer), msg.width, msg.height,
    );
    highResCache = {
      tier: msg.tier,
      resScale: msg.resScale,
      x0: msg.x0, y0: msg.y0, x1: msg.x1, y1: msg.y1,
      buffer: imageData,
    };
    render();
  }
};

// --- Map dimensions ---
const MAP_WIDTH = 300;
const MAP_HEIGHT = 500;

// --- Canvas size (display resolution) ---
const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 800;

// --- UI Elements ---
const canvas = document.getElementById("terrain") as HTMLCanvasElement;
const seedInput = document.getElementById("seed") as HTMLInputElement;
const generateBtn = document.getElementById("generate") as HTMLButtonElement;
const randomBtn = document.getElementById("random") as HTMLButtonElement;
const vegCheckbox = document.getElementById("vegetation") as HTMLInputElement;
const legendContainer = document.getElementById("legend") as HTMLElement;
const cursorInfo = document.getElementById("cursor-info") as HTMLElement;
const zoomInfo = document.getElementById("zoom-info") as HTMLElement;

canvas.width = CANVAS_WIDTH;
canvas.height = CANVAS_HEIGHT;

// --- Render legend ---
renderLegend(legendContainer);

// --- Zoom tier helpers ---
function getZoomTier(zoom: number): 1 | 2 | 3 {
  return zoom < 3 ? 1 : zoom < 8 ? 2 : 3;
}

/**
 * Computes the padded patch bounds (in coarse terrain coordinates) that
 * should be generated for the current viewport, capped to a sensible maximum
 * so generation stays fast. Also returns the raw visible-area corners for
 * cache-validity checking.
 */
function computePatchBounds(terrain: TerrainMap, vp: Viewport) {
  const baseScale = Math.min(canvas.width / terrain.width, canvas.height / terrain.height);
  const scale = baseScale * vp.zoom;
  const viewW = canvas.width / scale;
  const viewH = canvas.height / scale;
  let sx = Math.max(0, Math.min(terrain.width  - viewW, vp.cx - viewW / 2));
  let sy = Math.max(0, Math.min(terrain.height - viewH, vp.cy - viewH / 2));

  const tier = getZoomTier(vp.zoom);
  const pad  = tier === 2 ? 20 : 10;
  const maxW = tier === 2 ? 120 : 60;
  const maxH = tier === 2 ? 180 : 90;

  let x0 = Math.max(0, Math.floor(sx) - pad);
  let y0 = Math.max(0, Math.floor(sy) - pad);
  let x1 = Math.min(terrain.width,  Math.ceil(sx + viewW) + pad);
  let y1 = Math.min(terrain.height, Math.ceil(sy + viewH) + pad);

  if (x1 - x0 > maxW) {
    const cx = (x0 + x1) / 2;
    x0 = Math.floor(cx - maxW / 2);
    x1 = x0 + maxW;
  }
  if (y1 - y0 > maxH) {
    const cy = (y0 + y1) / 2;
    y0 = Math.floor(cy - maxH / 2);
    y1 = y0 + maxH;
  }

  return { x0, y0, x1, y1, viewSx: sx, viewSy: sy, viewW, viewH };
}

// --- Render current state ---
function render(): void {
  if (!currentTerrain || !currentBuffer) return;

  const tier = getZoomTier(viewport.zoom);

  if (tier === 1) {
    highResCache = null;
    pendingBounds = null;
    renderViewport(canvas, currentBuffer, currentTerrain, viewport);
    updateZoomDisplay();
    return;
  }

  const resScale = tier === 2 ? 8 : 16;
  const bounds = computePatchBounds(currentTerrain, viewport);

  const cacheValid =
    highResCache !== null &&
    highResCache.tier === tier &&
    bounds.viewSx >= highResCache.x0 &&
    bounds.viewSy >= highResCache.y0 &&
    bounds.viewSx + bounds.viewW <= highResCache.x1 &&
    bounds.viewSy + bounds.viewH <= highResCache.y1;

  if (!cacheValid) {
    // Progressive fallback: show the coarse buffer immediately so the map is
    // never blank while the worker computes the fine patch.
    renderViewport(canvas, currentBuffer, currentTerrain, viewport);
    updateZoomDisplay();

    // Only send a new request if the viewport has moved outside the patch the
    // worker is already computing — avoids flooding it during fast panning.
    const needsNewRequest =
      !pendingBounds ||
      bounds.viewSx < pendingBounds.x0 ||
      bounds.viewSy < pendingBounds.y0 ||
      bounds.viewSx + bounds.viewW > pendingBounds.x1 ||
      bounds.viewSy + bounds.viewH > pendingBounds.y1;

    if (needsNewRequest && workerReady) {
      pendingRequestId++;
      pendingBounds = { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: bounds.y1 };
      patchWorker.postMessage({
        type: "patch",
        x0: bounds.x0, y0: bounds.y0,
        w: bounds.x1 - bounds.x0,
        h: bounds.y1 - bounds.y0,
        resScale, showVegetation,
        requestId: pendingRequestId,
      });
    }
    return;
  }

  renderHighResViewport(canvas, highResCache!, viewport, currentTerrain);
  updateZoomDisplay();
}

function updateZoomDisplay(): void {
  if (zoomInfo) {
    const tier = getZoomTier(viewport.zoom);
    const tierLabel = tier === 1 ? "" : ` · tier ${tier}`;
    zoomInfo.textContent = `Zoom: ${viewport.zoom.toFixed(1)}x${tierLabel}`;
  }
}

// --- Cell lookup ---
// Fine terrain lives in the worker, so cursor inspection always uses the
// coarse cell. Geology and coast/river status are identical; altitude is
// within ~30 m of the fine value, which is imperceptible in the tooltip.
function getHoveredCell(clientX: number, clientY: number): TerrainCell | null {
  if (!currentTerrain) return null;
  const pos = canvasToTerrain(canvas, currentTerrain, viewport, clientX, clientY);
  if (!pos) return null;
  return currentTerrain.cells[pos.y][pos.x];
}

// --- Generate terrain ---
function generate(seed: string): void {
  const startTime = performance.now();

  const noise = createSeededNoise(seed);
  currentTerrain = generateTerrain(noise, MAP_WIDTH, MAP_HEIGHT, seed);
  bakeVegetationNoise(currentTerrain);
  currentBuffer = renderTerrainToBuffer(currentTerrain, showVegetation);
  highResCache = null;
  pendingBounds = null;
  pendingRequestId++; // invalidate any in-flight patch from the previous map
  workerReady = false;
  patchWorker.postMessage({ type: "prepare", seed });

  // Reset viewport to show whole map
  viewport = {
    cx: MAP_WIDTH / 2,
    cy: MAP_HEIGHT / 2,
    zoom: 1,
  };

  render();

  const elapsed = Math.round(performance.now() - startTime);
  console.log(`Generated terrain from seed "${seed}" in ${elapsed}ms`);
}

// --- Event handlers ---
generateBtn.addEventListener("click", () => {
  generate(seedInput.value.trim() || "barrow");
});

randomBtn.addEventListener("click", () => {
  const randomSeed = Math.random().toString(36).substring(2, 10);
  seedInput.value = randomSeed;
  generate(randomSeed);
});

vegCheckbox.addEventListener("change", () => {
  showVegetation = vegCheckbox.checked;
  if (!currentTerrain) return;
  // Coarse buffer re-renders from baked noise — fast, no noise recomputation.
  currentBuffer = renderTerrainToBuffer(currentTerrain, showVegetation);
  // Invalidate the fine cache; render() will show coarse fallback immediately
  // and dispatch a new patch request to the worker with updated showVegetation.
  highResCache = null;
  pendingBounds = null;
  render();
});

// --- Zoom with scroll wheel ---
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (!currentTerrain) return;

    const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newZoom = Math.max(1, Math.min(20, viewport.zoom * zoomFactor));

    // Zoom toward the cursor position
    const pos = canvasToTerrain(canvas, currentTerrain, viewport, e.clientX, e.clientY);
    if (pos) {
      // Interpolate centre toward cursor when zooming in
      const t = 1 - viewport.zoom / newZoom;
      if (e.deltaY < 0) {
        viewport.cx += (pos.x - viewport.cx) * t * 0.5;
        viewport.cy += (pos.y - viewport.cy) * t * 0.5;
      }
    }

    viewport.zoom = newZoom;
    render();
  },
  { passive: false }
);

// --- Pan with mouse drag ---
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartCx = 0;
let dragStartCy = 0;

canvas.addEventListener("mousedown", (e) => {
  isDragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragStartCx = viewport.cx;
  dragStartCy = viewport.cy;
  canvas.style.cursor = "grabbing";
});

window.addEventListener("mousemove", (e) => {
  if (!isDragging || !currentTerrain) return;

  const rect = canvas.getBoundingClientRect();
  const baseScale = Math.min(
    canvas.width / currentTerrain.width,
    canvas.height / currentTerrain.height
  );
  const scale = baseScale * viewport.zoom;

  // Convert pixel drag distance to terrain units
  const dx = ((e.clientX - dragStartX) * (canvas.width / rect.width)) / scale;
  const dy = ((e.clientY - dragStartY) * (canvas.height / rect.height)) / scale;

  viewport.cx = dragStartCx - dx;
  viewport.cy = dragStartCy - dy;

  render();
});

window.addEventListener("mouseup", () => {
  isDragging = false;
  canvas.style.cursor = "crosshair";
});

// --- Touch support for mobile ---
let lastTouchDist = 0;

canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    isDragging = true;
    dragStartCx = viewport.cx;
    dragStartCy = viewport.cy;
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
  } else if (e.touches.length === 2) {
    isDragging = false;
    lastTouchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  }
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  if (!currentTerrain) return;

  if (e.touches.length === 1 && isDragging) {
    const rect = canvas.getBoundingClientRect();
    const baseScale = Math.min(
      canvas.width / currentTerrain.width,
      canvas.height / currentTerrain.height
    );
    const scale = baseScale * viewport.zoom;

    const dx = ((e.touches[0].clientX - dragStartX) * (canvas.width / rect.width)) / scale;
    const dy = ((e.touches[0].clientY - dragStartY) * (canvas.height / rect.height)) / scale;

    viewport.cx = dragStartCx - dx;
    viewport.cy = dragStartCy - dy;
    render();
  } else if (e.touches.length === 2) {
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const zoomFactor = dist / lastTouchDist;
    viewport.zoom = Math.max(1, Math.min(20, viewport.zoom * zoomFactor));
    lastTouchDist = dist;
    render();
  }
}, { passive: false });

canvas.addEventListener("touchend", () => {
  isDragging = false;
});

// --- Cursor inspection ---
canvas.addEventListener("mousemove", (e) => {
  if (isDragging || !currentTerrain) return;

  const cell = getHoveredCell(e.clientX, e.clientY);
  if (cell) {
    const info = GEOLOGY_INFO[cell.geology];
    const altMetres = Math.round(cell.altitude * 1200);
    const river = cell.riverFlow > 0 ? " · River" : "";
    const coast = cell.isCoast ? " · Coast" : "";

    cursorInfo.textContent =
      `${info.label} · ${altMetres}m${river}${coast} — ${info.description}`;
  }
});

canvas.addEventListener("mouseleave", () => {
  cursorInfo.textContent = "";
});

// --- Keyboard zoom controls ---
window.addEventListener("keydown", (e) => {
  if (e.key === "+" || e.key === "=") {
    viewport.zoom = Math.min(20, viewport.zoom * 1.2);
    render();
  } else if (e.key === "-" || e.key === "_") {
    viewport.zoom = Math.max(1, viewport.zoom / 1.2);
    render();
  } else if (e.key === "0") {
    viewport = { cx: MAP_WIDTH / 2, cy: MAP_HEIGHT / 2, zoom: 1 };
    render();
  }
});

// --- Set canvas cursor ---
canvas.style.cursor = "crosshair";

// --- Initial generation ---
generate("barrow");

