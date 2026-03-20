import { TerrainMap, TerrainCell } from "./terrain";
import { GEOLOGY_INFO, GeologyType } from "./geology";
import { createSeededNoise, layeredNoise } from "./noise";

// ---------------------------------------------------------------------------
// Vegetation overlay
// ---------------------------------------------------------------------------

// Per-geology vegetation noise parameters, sampled in nx/ny world-space (0..1).
// Scale controls patch size (higher = smaller patches).
// Offset decorrelates the pattern between geology types.
// Must stay in sync with bakeVegetationNoise below.
const VEG_NOISE_SCALE: Partial<Record<GeologyType, number>> = {
  [GeologyType.Clay]:      4,
  [GeologyType.Limestone]: 7,
  [GeologyType.Sandstone]: 7,
  [GeologyType.Slate]:     7,
  [GeologyType.Chalk]:     9,
  [GeologyType.Granite]:   12,
  [GeologyType.Glacial]:   14,
};

const VEG_NOISE_OFFSET: Partial<Record<GeologyType, number>> = {
  [GeologyType.Chalk]:     50,
  [GeologyType.Limestone]: 55,
  [GeologyType.Sandstone]: 60,
  [GeologyType.Granite]:   65,
  [GeologyType.Slate]:     70,
  [GeologyType.Clay]:      75,
  [GeologyType.Glacial]:   80,
};

/**
 * Pre-bakes per-cell vegetation noise into terrain.vegNoise.
 * Each cell gets a single scalar [-1..1] using the correct scale and offset
 * for its geology type. After baking, renderTerrainToBuffer does fast array
 * lookups instead of calling layeredNoise per cell during rendering.
 * Call once after terrain generation; reuse across multiple renders.
 */
export function bakeVegetationNoise(terrain: TerrainMap): void {
  const { width, height, cells, seed } = terrain;
  const vegNoise2D = createSeededNoise(seed + "\0veg").noise2D;
  const data = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y][x];
      const scale = VEG_NOISE_SCALE[cell.geology];
      if (scale === undefined) { data[y * width + x] = 0; continue; }
      const offset = VEG_NOISE_OFFSET[cell.geology]!;
      data[y * width + x] = layeredNoise(
        vegNoise2D,
        cell.nx + offset,
        (1 - cell.ny) + offset,
        4, 0.5, 2.0, scale,
      );
    }
  }

  terrain.vegNoise = data;
}

/**
 * Computes a vegetation colour and blend factor for a land cell.
 * Returns null for Water and Ice (no vegetation).
 *
 * vn is the pre-baked vegetation noise value for this cell (from terrain.vegNoise).
 * The blend factor falls off with altitude so exposed ridges show bare rock.
 */
function computeVegetationColor(
  cell: TerrainCell,
  cells: TerrainCell[][],
  x: number,
  y: number,
  width: number,
  height: number,
  vn: number,
): { r: number; g: number; b: number; blend: number } | null {
  const { geology, altitude, nx } = cell;

  if (geology === GeologyType.Water || geology === GeologyType.Ice) return null;

  // A cell is "near a river" if it or a 4-cardinal neighbour carries flow.
  // River cells themselves get the blue river overlay on top, so riparian
  // vegetation mainly colours the adjacent bank cells.
  const nearRiver =
    cell.riverFlow > 0 ||
    (x > 0 && cells[y][x - 1].riverFlow > 0) ||
    (x < width - 1 && cells[y][x + 1].riverFlow > 0) ||
    (y > 0 && cells[y - 1][x].riverFlow > 0) ||
    (y < height - 1 && cells[y + 1][x].riverFlow > 0);

  const seaLevel = 0.22;
  const treeline = 0.45;

  // Altitude-based blend: lush forest at low altitude, bare rock at peaks.
  let blend: number;
  if (altitude < treeline) {
    const t = Math.max(0, (altitude - seaLevel) / (treeline - seaLevel));
    blend = 0.85 - t * 0.25; // 0.85 at coast → 0.60 at treeline
  } else {
    const t = Math.min(1, (altitude - treeline) / (1.0 - treeline));
    blend = 0.30 - t * 0.25; // 0.30 at treeline → 0.05 at summits
  }

  let vegR: number, vegG: number, vegB: number;

  switch (geology) {
    case GeologyType.Chalk: {
      // Open and light — least forested geology. Large grassland patches with
      // scattered scrub and dark yew in sheltered combes at low altitude.
      if (nearRiver && cell.riverFlow === 0) {
        vegR = 110; vegG = 155; vegB = 55; // riparian: brighter green
      } else if (altitude < 0.30 && vn < -0.35) {
        vegR = 55; vegG = 95; vegB = 40;  // sheltered combes: dark yew/hazel
        blend *= 0.80;
      } else if (vn > 0.30) {
        vegR = 120; vegG = 145; vegB = 70; // scattered scrub patches
      } else {
        vegR = 190; vegG = 200; vegB = 120; // open grassland: pale green-gold
      }
      if (altitude > 0.38) blend *= 0.55; // exposed chalk — minimal cover
      break;
    }

    case GeologyType.Limestone: {
      // Strong altitude contrast: green valley floors, grey exposed plateaux.
      if (altitude > 0.40) {
        // Bare limestone pavement: geology shows through with just a hint of colour
        vegR = 165; vegG = 170; vegB = 145;
        blend = Math.min(blend, 0.22);
      } else if (nearRiver || altitude < 0.30) {
        // Valley floor: lush ash woodland
        vegR = 65; vegG = 110; vegB = 40;
        blend = Math.min(0.88, blend * 1.10);
      } else {
        // Dale slopes: mixed woodland with patchy rocky outcrops
        const t = (altitude - 0.30) / (0.40 - 0.30);
        vegR = Math.round(65 + t * 35);
        vegG = Math.round(110 + t * 18);
        vegB = Math.round(40 + t * 22);
        if (vn > 0.25) blend *= 0.55; // rocky outcrops show through
      }
      break;
    }

    case GeologyType.Sandstone: {
      // Warmer, more purple-brown palette. Heather moorland dominant,
      // birch-pine in shelter, alder-willow along streams.
      if (nearRiver && cell.riverFlow === 0) {
        vegR = 110; vegG = 160; vegB = 45; // alder-willow: bright yellow-green
      } else if (vn > 0.22) {
        vegR = 65; vegG = 90; vegB = 72;   // birch/pine: slightly blue-green
      } else {
        vegR = 128; vegG = 82; vegB = 112; // heathland: purple-brown heather
      }
      break;
    }

    case GeologyType.Granite: {
      // Bare, wind-scoured moorland dominant. Small dark oakwood patches in
      // sheltered valleys. Lichen-toned rock at high altitude.
      if (altitude > 0.50) {
        vegR = 162; vegG = 155; vegB = 110; // lichen on high rock: pale yellow-grey
        blend = Math.min(blend, 0.28);
      } else if (altitude < 0.36 && vn < -0.38) {
        vegR = 38; vegG = 72; vegB = 28;   // stunted valley oakwood: very dark, patchy
        blend *= 0.85;
      } else if (nearRiver && altitude < 0.38) {
        vegR = 80; vegG = 120; vegB = 50;  // riparian scrub in valley bottoms
      } else {
        vegR = 105; vegG = 100; vegB = 42; // moorland: olive-brown tussock/bog
      }
      if (altitude > treeline) blend *= 0.45; // very exposed above treeline
      break;
    }

    case GeologyType.Slate: {
      // Signature contrast: impenetrably dark valley forest vs bare ridge moorland.
      if (altitude > treeline) {
        vegR = 96; vegG = 96; vegB = 42;   // bare moorland on ridges
        blend = Math.min(blend, 0.42);
      } else if (altitude < 0.35 || vn < -0.08) {
        vegR = 24; vegG = 68; vegB = 35;   // dense oak-hazel: very dark green
        blend = Math.min(0.90, blend * 1.15);
      } else {
        vegR = 38; vegG = 80; vegB = 42;   // fern/moss on slopes
      }
      break;
    }

    case GeologyType.Clay: {
      // Darkest, densest vegetation. Primeval wildwood dominates. Carr near
      // rivers. Golden reed beds in the eastern water-lands at very low altitude.
      if (altitude < 0.27 && nx > 0.65) {
        // Eastern water-lands: reed beds, warm golden-brown
        vegR = 138; vegG = 122; vegB = 45;
        blend = 0.75;
      } else if (nearRiver && cell.riverFlow === 0) {
        vegR = 52; vegG = 95; vegB = 45;   // alder-willow carr: lighter, wetter
        blend = Math.min(0.90, blend * 1.05);
      } else if (vn > 0.28) {
        vegR = 55; vegG = 88; vegB = 40;   // natural canopy gaps, clearings
      } else {
        vegR = 28; vegG = 58; vegB = 28;   // primeval wildwood: very dark green
        blend = Math.min(0.92, blend * 1.12);
      }
      break;
    }

    case GeologyType.Glacial: {
      // Pioneer vegetation only. Barely-there green over raw rock, slightly
      // denser (higher blend) further from the ice at lower altitude.
      if (vn > 0.30) {
        vegR = 120; vegG = 138; vegB = 95;  // scattered birch/willow: pale green
      } else {
        vegR = 150; vegG = 158; vegB = 115; // pioneer moss/lichen: barely-there
      }
      blend = Math.min(blend, 0.40);
      if (altitude < 0.35) blend = Math.min(blend * 1.3, 0.45); // further from ice
      break;
    }

    default:
      return null;
  }

  return { r: vegR, g: vegG, b: vegB, blend: Math.max(0, Math.min(1, blend)) };
}

// --- Full-resolution offscreen rendering ---

export function renderTerrainToBuffer(terrain: TerrainMap, showVegetation = false): ImageData {
  const { width, height, cells, vegNoise } = terrain;
  const imageData = new ImageData(width, height);
  const data = imageData.data;

  // Use pre-baked noise for vegetation — fast array lookup instead of per-cell
  // layeredNoise calls. If somehow not baked, vegetation is silently skipped.
  const useVegetation = showVegetation && vegNoise !== undefined;

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

      // Vegetation overlay — blended before hillshading so terrain shape
      // is applied on top, giving the vegetation colour depth and relief.
      if (useVegetation) {
        const veg = computeVegetationColor(
          cell, cells, x, y, width, height, vegNoise![y * width + x],
        );
        if (veg) {
          r = r * (1 - veg.blend) + veg.r * veg.blend;
          g = g * (1 - veg.blend) + veg.g * veg.blend;
          b = b * (1 - veg.blend) + veg.b * veg.blend;
        }
      }

      // Hillshading — simulated NW light source at 45° elevation.
      // Skipped for water (flat surface; depth shading already does the work).
      if (cell.geology !== GeologyType.Water) {
        // Altitude of orthogonal neighbours, clamped to grid bounds
        const altW = cells[y][Math.max(0, x - 1)].altitude;
        const altE = cells[y][Math.min(width - 1, x + 1)].altitude;
        const altN = cells[Math.max(0, y - 1)][x].altitude;   // y-1 is north
        const altS = cells[Math.min(height - 1, y + 1)][x].altitude;

        // Central-difference gradient: (east component, north component)
        const dzdx = (altE - altW) * 0.5;
        const dzdy = (altN - altS) * 0.5;   // sign: y-1 = north = higher ny

        // Unnormalised surface normal in (east, north, up) space.
        // z-factor exaggerates vertical relief so subtle slopes cast visible shade.
        const zf = 8.0;
        const snx = -dzdx * zf;
        const sny = -dzdy * zf;
        // snz = 1.0 (implicit; included in length below)

        // Dot with NW-45° light unit vector (-0.5, 0.5, 0.707).
        // (-0.5)²+(0.5)²+(0.707)² = 0.25+0.25+0.5 = 1.0 — already unit length.
        const dot = snx * (-0.5) + sny * 0.5 + 0.707;
        const hillshade = Math.max(0, dot / Math.sqrt(snx * snx + sny * sny + 1.0));

        // Shade factor: 0.70 fully shadowed → 1.30 fully lit.
        // Normalised so a flat horizontal surface (hillshade ≈ 0.707) gets ≈ 1.12.
        const sf = 0.70 + hillshade * 0.60;
        r *= sf;
        g *= sf;
        b *= sf;
      }

      // River overlay
      if (cell.riverFlow > 0) {
        const riverIntensity = Math.min(1, cell.riverFlow / 500);
        const riverR = 50;
        const riverG = 70 + riverIntensity * 20;
        const riverB = 100 + riverIntensity * 30;
        let blend = 0.6 + riverIntensity * 0.3;
        // Safety net for subpixel-wide rivers: if no neighbours have riverFlow,
        // this is a 1-cell-wide river that may be thinner than a canvas pixel.
        // Boost the blend so it stays visible even when partially covered.
        const isolated =
          (x === 0 || cells[y][x - 1].riverFlow === 0) &&
          (x === width - 1 || cells[y][x + 1].riverFlow === 0) &&
          (y === 0 || cells[y - 1][x].riverFlow === 0) &&
          (y === height - 1 || cells[y + 1][x].riverFlow === 0);
        if (isolated) blend = Math.min(1, blend + 0.25);
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

  const offscreen = new OffscreenCanvas(cache.buffer.width, cache.buffer.height);
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

// --- Key panel ---

// Representative vegetation colours shown in the key, ordered by geology then
// by visual character. These mirror the colours used in computeVegetationColor.
const VEG_KEY_ENTRIES: Array<{ color: string; label: string }> = [
  { color: "rgb(190,200,120)", label: "Chalk grassland" },
  { color: "rgb(120,145,70)",  label: "Chalk scrub" },
  { color: "rgb(55,95,40)",    label: "Chalk yew & hazel" },
  { color: "rgb(65,110,40)",   label: "Limestone ash wood" },
  { color: "rgb(165,170,145)", label: "Limestone pavement" },
  { color: "rgb(128,82,112)",  label: "Sandstone heathland" },
  { color: "rgb(65,90,72)",    label: "Sandstone birch-pine" },
  { color: "rgb(105,100,42)",  label: "Granite moorland" },
  { color: "rgb(38,72,28)",    label: "Granite valley oakwood" },
  { color: "rgb(162,155,110)", label: "Granite lichen rock" },
  { color: "rgb(24,68,35)",    label: "Slate oak-hazel wood" },
  { color: "rgb(96,96,42)",    label: "Slate ridge moorland" },
  { color: "rgb(28,58,28)",    label: "Clay wildwood" },
  { color: "rgb(52,95,45)",    label: "Clay alder-willow carr" },
  { color: "rgb(138,122,45)",  label: "Clay reed beds" },
  { color: "rgb(150,158,115)", label: "Glacial pioneer lichen" },
  { color: "rgb(120,138,95)",  label: "Glacial birch & willow" },
  { color: "rgb(110,160,45)",  label: "River margins (all)" },
];

const GEO_ORDER: GeologyType[] = [
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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function sectionTitle(text: string): HTMLElement {
  return el("div", "key-section-title", text);
}

/**
 * Builds the full key panel: a Geology section (with colour swatches and
 * descriptions) and a Vegetation section (representative colours and labels).
 * Call once at startup; the panel content never needs to change.
 */
export function renderKeyPanel(container: HTMLElement): void {
  container.innerHTML = "";

  // --- Geology section ---
  container.appendChild(sectionTitle("Geology"));

  for (const type of GEO_ORDER) {
    const info = GEOLOGY_INFO[type];
    const item = el("div", "key-geo-item");

    const swatch = el("div", "key-geo-swatch");
    swatch.style.backgroundColor = info.color;

    const text = el("div");
    const name = el("span", "key-geo-name", info.label);
    const desc = el("span", "key-geo-desc", info.description);
    text.appendChild(name);
    text.appendChild(desc);

    item.appendChild(swatch);
    item.appendChild(text);
    container.appendChild(item);
  }

  // --- Vegetation section ---
  container.appendChild(sectionTitle("Vegetation"));

  for (const entry of VEG_KEY_ENTRIES) {
    const item = el("div", "key-veg-item");

    const swatch = el("div", "key-veg-swatch");
    swatch.style.backgroundColor = entry.color;

    const label = el("span", "key-veg-label", entry.label);

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