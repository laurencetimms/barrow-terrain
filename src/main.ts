import { createSeededNoise } from "./noise";
import { generateTerrain, TerrainMap } from "./terrain";
import { GEOLOGY_INFO } from "./geology";
import {
  renderTerrainToBuffer,
  renderViewport,
  renderLegend,
  canvasToTerrain,
  Viewport,
} from "./renderer";

// --- State ---
let currentTerrain: TerrainMap | null = null;
let currentBuffer: ImageData | null = null;
let viewport: Viewport = { cx: 150, cy: 250, zoom: 1 };

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
const legendContainer = document.getElementById("legend") as HTMLElement;
const cursorInfo = document.getElementById("cursor-info") as HTMLElement;
const zoomInfo = document.getElementById("zoom-info") as HTMLElement;

canvas.width = CANVAS_WIDTH;
canvas.height = CANVAS_HEIGHT;

// --- Render legend ---
renderLegend(legendContainer);

// --- Render current state ---
function render(): void {
  if (!currentTerrain || !currentBuffer) return;
  renderViewport(canvas, currentBuffer, currentTerrain, viewport);
  updateZoomDisplay();
}

function updateZoomDisplay(): void {
  if (zoomInfo) {
    zoomInfo.textContent = `Zoom: ${viewport.zoom.toFixed(1)}x`;
  }
}

// --- Generate terrain ---
function generate(seed: string): void {
  const startTime = performance.now();

  const noise = createSeededNoise(seed);
  currentTerrain = generateTerrain(noise, MAP_WIDTH, MAP_HEIGHT, seed);
  currentBuffer = renderTerrainToBuffer(currentTerrain);

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
let lastTouchX = 0;
let lastTouchY = 0;

canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    isDragging = true;
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
    dragStartCx = viewport.cx;
    dragStartCy = viewport.cy;
    dragStartX = lastTouchX;
    dragStartY = lastTouchY;
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

  const pos = canvasToTerrain(canvas, currentTerrain, viewport, e.clientX, e.clientY);
  if (pos) {
    const cell = currentTerrain.cells[pos.y][pos.x];
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