import { TerrainMap } from "./terrain";
import { GEOLOGY_INFO, GeologyType } from "./geology";

// --- Full-resolution offscreen rendering ---

export function renderTerrainToBuffer(terrain: TerrainMap): ImageData {
  const { width, height, cells } = terrain;
  const imageData = new ImageData(width, height);
  const data = imageData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y][x];
      const idx = (y * width + x) * 4;

      const geoInfo = GEOLOGY_INFO[cell.geology];
      const baseColor = hexToRgb(geoInfo.color);

      const altShade =
        cell.geology === GeologyType.Water ? 1.0
        : cell.geology === GeologyType.Ice  ? 0.92 + cell.altitude * 0.10
        : 0.7 + cell.altitude * 0.6;

      let r = baseColor.r * altShade;
      let g = baseColor.g * altShade;
      let b = baseColor.b * altShade;

      // Water depth shading
      if (cell.geology === GeologyType.Water) {
        const depthFactor = 0.6 + cell.altitude * 1.8;
        r = baseColor.r * depthFactor;
        g = baseColor.g * depthFactor;
        b = baseColor.b * depthFactor;
      }

      // Coast highlight
      if (cell.isCoast) {
        r = Math.min(255, r + 15);
        g = Math.min(255, g + 12);
        b = Math.min(255, b + 8);
      }

      // River overlay
      if (cell.riverFlow > 0) {
        const riverIntensity = Math.min(1, cell.riverFlow / 500);
        const riverR = 50;
        const riverG = 70 + riverIntensity * 20;
        const riverB = 100 + riverIntensity * 30;
        const blend = 0.6 + riverIntensity * 0.3;
        r = r * (1 - blend) + riverR * blend;
        g = g * (1 - blend) + riverG * blend;
        b = b * (1 - blend) + riverB * blend;
      }

      data[idx] = Math.min(255, Math.max(0, Math.round(r)));
      data[idx + 1] = Math.min(255, Math.max(0, Math.round(g)));
      data[idx + 2] = Math.min(255, Math.max(0, Math.round(b)));
      data[idx + 3] = 255;
    }
  }

  return imageData;
}

// --- Zoom/pan viewport ---

export interface Viewport {
  // Centre of the view in terrain coordinates
  cx: number;
  cy: number;
  // Zoom level: 1 = fit whole map, 2 = 2x zoom, etc.
  zoom: number;
}

export function renderViewport(
  canvas: HTMLCanvasElement,
  buffer: ImageData,
  terrain: TerrainMap,
  viewport: Viewport
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const cw = canvas.width;
  const ch = canvas.height;

  // Clear
  ctx.fillStyle = "#1c1a17";
  ctx.fillRect(0, 0, cw, ch);

  // Create an offscreen canvas with the full terrain image
  const offscreen = new OffscreenCanvas(terrain.width, terrain.height);
  const offCtx = offscreen.getContext("2d");
  if (!offCtx) return;
  offCtx.putImageData(buffer, 0, 0);

  // Calculate the source rectangle (what portion of the terrain to show)
  const baseScale = Math.min(cw / terrain.width, ch / terrain.height);
  const scale = baseScale * viewport.zoom;

  // How many terrain pixels fit in the canvas at this zoom
  const viewW = cw / scale;
  const viewH = ch / scale;

  // Source rectangle, clamped to terrain bounds
  let sx = viewport.cx - viewW / 2;
  let sy = viewport.cy - viewH / 2;

  // Clamp so we don't go outside the terrain
  sx = Math.max(0, Math.min(terrain.width - viewW, sx));
  sy = Math.max(0, Math.min(terrain.height - viewH, sy));

  // Use nearest-neighbour rendering for crisp pixels when zoomed
  ctx.imageSmoothingEnabled = viewport.zoom > 2 ? false : true;

  ctx.drawImage(
    offscreen,
    sx,
    sy,
    viewW,
    viewH,
    0,
    0,
    cw,
    ch
  );
}

// --- High-resolution viewport ---

/**
 * Renders a high-resolution patch to the canvas. The cache covers a
 * rectangular sub-region of the coarse terrain at resScale fine cells per
 * coarse cell. The viewport is still expressed in coarse terrain coordinates.
 */
export function renderHighResViewport(
  canvas: HTMLCanvasElement,
  cache: {
    resScale: number;
    x0: number;
    y0: number;
    terrain: TerrainMap;
    buffer: ImageData;
  },
  viewport: Viewport,
  coarseTerrain: TerrainMap
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const cw = canvas.width;
  const ch = canvas.height;

  ctx.fillStyle = "#1c1a17";
  ctx.fillRect(0, 0, cw, ch);

  const offscreen = new OffscreenCanvas(cache.terrain.width, cache.terrain.height);
  const offCtx = offscreen.getContext("2d");
  if (!offCtx) return;
  offCtx.putImageData(cache.buffer, 0, 0);

  const baseScale = Math.min(cw / coarseTerrain.width, ch / coarseTerrain.height);
  const scale = baseScale * viewport.zoom;
  const viewW = cw / scale;
  const viewH = ch / scale;

  let sx = viewport.cx - viewW / 2;
  let sy = viewport.cy - viewH / 2;
  sx = Math.max(0, Math.min(coarseTerrain.width  - viewW, sx));
  sy = Math.max(0, Math.min(coarseTerrain.height - viewH, sy));

  // Convert coarse viewport rect to fine patch pixel coordinates
  const fineSx = (sx - cache.x0) * cache.resScale;
  const fineSy = (sy - cache.y0) * cache.resScale;

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    offscreen,
    fineSx, fineSy, viewW * cache.resScale, viewH * cache.resScale,
    0, 0, cw, ch
  );
}

// Convert canvas pixel position to terrain cell coordinates
export function canvasToTerrain(
  canvas: HTMLCanvasElement,
  terrain: TerrainMap,
  viewport: Viewport,
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  const canvasX = (clientX - rect.left) * (canvas.width / rect.width);
  const canvasY = (clientY - rect.top) * (canvas.height / rect.height);

  const cw = canvas.width;
  const ch = canvas.height;

  const baseScale = Math.min(cw / terrain.width, ch / terrain.height);
  const scale = baseScale * viewport.zoom;

  const viewW = cw / scale;
  const viewH = ch / scale;

  let sx = viewport.cx - viewW / 2;
  let sy = viewport.cy - viewH / 2;
  sx = Math.max(0, Math.min(terrain.width - viewW, sx));
  sy = Math.max(0, Math.min(terrain.height - viewH, sy));

  const terrainX = Math.floor(sx + canvasX / scale);
  const terrainY = Math.floor(sy + canvasY / scale);

  if (
    terrainX >= 0 &&
    terrainX < terrain.width &&
    terrainY >= 0 &&
    terrainY < terrain.height
  ) {
    return { x: terrainX, y: terrainY };
  }
  return null;
}

// --- Legend ---

export function renderLegend(container: HTMLElement): void {
  container.innerHTML = "";
  const types: GeologyType[] = [
    GeologyType.Chalk,
    GeologyType.Limestone,
    GeologyType.Sandstone,
    GeologyType.Granite,
    GeologyType.Slate,
    GeologyType.Clay,
    GeologyType.Glacial,
    GeologyType.Ice,
    GeologyType.Water,
  ];

  for (const type of types) {
    const info = GEOLOGY_INFO[type];
    const item = document.createElement("div");
    item.className = "legend-item";

    const swatch = document.createElement("div");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = info.color;

    const label = document.createElement("span");
    label.textContent = info.label;

    item.appendChild(swatch);
    item.appendChild(label);
    container.appendChild(item);
  }
}

// --- Utility ---

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return { r: 128, g: 128, b: 128 };
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  };
}