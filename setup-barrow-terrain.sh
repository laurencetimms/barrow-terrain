#!/bin/bash
# The Barrow - Terrain Generator Setup
# Run this in the root of your barrow-terrain repo in Codespace

# Install dependencies
cat > package.json << 'PACKAGE'
{
  "name": "barrow-terrain",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vite": "^5.4.0"
  },
  "dependencies": {
    "simplex-noise": "^4.0.1"
  }
}
PACKAGE

cat > tsconfig.json << 'TSCONFIG'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
TSCONFIG

cat > vite.config.ts << 'VITE'
import { defineConfig } from "vite";

export default defineConfig({
  base: "/barrow-terrain/",
  build: {
    outDir: "dist",
  },
});
VITE

cat > index.html << 'HTML'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>The Barrow — Terrain</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;1,400&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: #1c1a17;
      color: #c4b9a8;
      font-family: 'EB Garamond', Georgia, serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 24px;
    }

    h1 {
      font-size: 15px;
      font-weight: 500;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #7a7268;
      margin-bottom: 4px;
    }

    .subtitle {
      font-size: 13px;
      color: #4a453e;
      font-style: italic;
      margin-bottom: 20px;
    }

    .controls {
      display: flex;
      gap: 12px;
      align-items: center;
      margin-bottom: 16px;
      flex-wrap: wrap;
      justify-content: center;
    }

    .controls label {
      font-size: 13px;
      color: #7a7268;
    }

    .controls input {
      background: #2a2620;
      border: 1px solid #3a3630;
      color: #c4b9a8;
      padding: 4px 8px;
      font-family: inherit;
      font-size: 13px;
      width: 120px;
      border-radius: 3px;
    }

    .controls button {
      background: #2e2a22;
      border: 1px solid #5a5040;
      color: #b8a88a;
      padding: 5px 14px;
      font-family: inherit;
      font-size: 13px;
      cursor: pointer;
      border-radius: 3px;
      transition: background 0.2s;
    }

    .controls button:hover {
      background: #3e3a32;
    }

    canvas {
      border: 1px solid #2a2620;
      max-width: 100%;
      height: auto;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 16px;
      justify-content: center;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      color: #7a7268;
    }

    .legend-swatch {
      width: 14px;
      height: 14px;
      border-radius: 2px;
      border: 1px solid #3a3630;
    }

    .info {
      margin-top: 16px;
      font-size: 13px;
      color: #4a453e;
      font-style: italic;
      text-align: center;
      max-width: 600px;
      line-height: 1.6;
    }

    .cursor-info {
      margin-top: 12px;
      font-size: 14px;
      color: #8a8078;
      text-align: center;
      min-height: 20px;
    }
  </style>
</head>
<body>
  <h1>The Barrow — Terrain Generator</h1>
  <p class="subtitle">The rock beneath the world</p>
  <div class="controls">
    <label for="seed">Seed:</label>
    <input type="text" id="seed" value="barrow" />
    <button id="generate">Generate</button>
    <button id="random">Random Seed</button>
  </div>
  <canvas id="terrain" width="600" height="800"></canvas>
  <div class="cursor-info" id="cursor-info"></div>
  <div class="legend" id="legend"></div>
  <div class="info">
    Each pixel is roughly one square mile. South at the bottom, north at the top.
    The mountain spine runs through the west. Chalk in the south, clay in the east,
    granite in the western highlands, glacial debris in the far north.
    Hover over the map to inspect.
  </div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
HTML

# Create source directory
mkdir -p src

# --- Noise utility ---
cat > src/noise.ts << 'NOISE'
import { createNoise2D } from "simplex-noise";

// Simple seedable PRNG (mulberry32)
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Convert string seed to number
function hashSeed(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash;
}

export interface NoiseGenerator {
  noise2D: (x: number, y: number) => number;
  random: () => number;
}

export function createSeededNoise(seed: string): NoiseGenerator {
  const numSeed = hashSeed(seed);
  const rng = mulberry32(numSeed);
  const noise2D = createNoise2D(rng);
  // Create a second rng stream for general random use
  const rng2 = mulberry32(numSeed + 12345);
  return { noise2D, random: rng2 };
}

// Layered noise: combine multiple octaves for natural-looking terrain
export function layeredNoise(
  noise2D: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves: number = 6,
  persistence: number = 0.5,
  lacunarity: number = 2.0,
  scale: number = 1.0
): number {
  let value = 0;
  let amplitude = 1;
  let frequency = scale;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    value += noise2D(x * frequency, y * frequency) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  return value / maxValue; // Normalise to roughly -1..1
}
NOISE

# --- Geology types ---
cat > src/geology.ts << 'GEOLOGY'
export enum GeologyType {
  Chalk = "chalk",
  Limestone = "limestone",
  Sandstone = "sandstone",
  Granite = "granite",
  Slate = "slate",
  Clay = "clay",
  Glacial = "glacial",
  Water = "water",
}

export interface GeologyInfo {
  type: GeologyType;
  label: string;
  color: string;
  description: string;
}

export const GEOLOGY_INFO: Record<GeologyType, GeologyInfo> = {
  [GeologyType.Chalk]: {
    type: GeologyType.Chalk,
    label: "Chalk",
    color: "#c8d8a8",
    description:
      "Rolling downland, white where the turf has slipped. Springs where the chalk meets clay. Flint in the soil.",
  },
  [GeologyType.Limestone]: {
    type: GeologyType.Limestone,
    label: "Limestone",
    color: "#b0b898",
    description:
      "Grey pavements and green dales. Caves where the water has carved through. Dry valleys and hidden springs.",
  },
  [GeologyType.Sandstone]: {
    type: GeologyType.Sandstone,
    label: "Sandstone",
    color: "#c8a878",
    description:
      "Warm-coloured rock, heathland and pine. Overhangs and shallow caves. The stone takes marks well.",
  },
  [GeologyType.Granite]: {
    type: GeologyType.Granite,
    label: "Granite",
    color: "#8a8a80",
    description:
      "Hard, ancient, resistant. Tors and boulder fields. Thin soil, moorland, bog. Harsh country.",
  },
  [GeologyType.Slate]: {
    type: GeologyType.Slate,
    label: "Slate",
    color: "#708078",
    description:
      "Steep valleys, fast rivers, dense oak in the valley floors. Thin layered rock, dark and wet.",
  },
  [GeologyType.Clay]: {
    type: GeologyType.Clay,
    label: "Clay",
    color: "#5a7848",
    description:
      "Heavy soil, thick forest. Oak and elm, almost impenetrable. The richest farmland, the densest wood.",
  },
  [GeologyType.Glacial]: {
    type: GeologyType.Glacial,
    label: "Glacial debris",
    color: "#9898a0",
    description:
      "Raw ground left by the retreating ice. Moraines, erratics, meltwater channels. No soil. Pioneer birch.",
  },
  [GeologyType.Water]: {
    type: GeologyType.Water,
    label: "Water",
    color: "#4a6878",
    description: "Sea, lake, or the shallow waters of the eastern water-lands.",
  },
};
GEOLOGY

# --- Terrain generation ---
cat > src/terrain.ts << 'TERRAIN'
import { NoiseGenerator, layeredNoise } from "./noise";
import { GeologyType } from "./geology";

export interface TerrainCell {
  altitude: number; // 0..1 where 0 is sea level, 1 is highest peak
  geology: GeologyType;
  riverFlow: number; // accumulated water flow, 0 = no river
  isCoast: boolean;
  // Normalised position in the world (0..1)
  nx: number; // 0 = west, 1 = east
  ny: number; // 0 = south, 1 = north
}

export interface TerrainMap {
  width: number;
  height: number;
  cells: TerrainCell[][];
  seed: string;
}

// The fixed frame masks — these shape the large-scale terrain
// to match The Barrow's geography

function mountainSpineMask(nx: number, ny: number): number {
  // Mountain spine in the western third, running north-south
  // Peaks around nx=0.2, fading east and west
  const spineCenter = 0.22;
  const spineWidth = 0.12;
  const distFromSpine = Math.abs(nx - spineCenter) / spineWidth;
  const spineInfluence = Math.max(0, 1 - distFromSpine * distFromSpine);

  // Spine is strongest in the middle latitudes, fading at the extremes
  const latFade = 1 - Math.pow(Math.abs(ny - 0.5) * 2, 2) * 0.4;

  return spineInfluence * latFade * 0.6;
}

function chalkSouthMask(nx: number, ny: number): number {
  // Chalk escarpment in the south, running east-west
  // Moderate elevation, strongest at ny=0.1-0.2
  const southInfluence = Math.max(0, 1 - ny / 0.3);
  // The escarpment ridge — a specific band of higher ground
  const ridgeDist = Math.abs(ny - 0.15) / 0.05;
  const ridgeBoost = Math.max(0, 1 - ridgeDist) * 0.15;

  // Fades in the far west where granite takes over
  const westFade = Math.min(1, nx / 0.15);

  return (southInfluence * 0.2 + ridgeBoost) * westFade;
}

function easternLowlandsMask(nx: number, ny: number): number {
  // Eastern half is lower — clay lowlands descending toward the water-lands
  const eastInfluence = Math.max(0, (nx - 0.5) / 0.5);
  return -eastInfluence * 0.3;
}

function northernIceMask(ny: number): number {
  // Far north drops and becomes glacial
  const northInfluence = Math.max(0, (ny - 0.8) / 0.2);
  return -northInfluence * 0.15;
}

function waterLandsMask(nx: number, ny: number): number {
  // Eastern edge — the water-lands. Very low, partially submerged
  const waterLandsInfluence = Math.max(0, (nx - 0.75) / 0.25);
  // Stronger in the middle latitudes
  const latWeight = 1 - Math.pow(Math.abs(ny - 0.45) * 2, 2) * 0.5;
  return -waterLandsInfluence * latWeight * 0.35;
}

function seaMask(nx: number, ny: number): number {
  // South coast — sea below the land
  const southSea = Math.max(0, (0.05 - ny) / 0.05);
  // West coast — irregular, indented
  const westSea = Math.max(0, (0.06 - nx) / 0.06);
  return -(southSea + westSea) * 0.5;
}

export function generateTerrain(
  noise: NoiseGenerator,
  width: number,
  height: number,
  seed: string
): TerrainMap {
  const cells: TerrainCell[][] = [];

  // Phase 1: Generate raw heightmap with geological masks
  for (let y = 0; y < height; y++) {
    const row: TerrainCell[] = [];
    for (let x = 0; x < width; x++) {
      // Normalised position: nx 0=west 1=east, ny 0=south 1=north
      const nx = x / width;
      const ny = 1 - y / height; // Flip so north is top of array

      // Base terrain from layered noise
      const baseNoise = layeredNoise(
        noise.noise2D,
        x,
        y,
        6,
        0.5,
        2.0,
        0.008
      );

      // Combine with fixed-frame masks
      let altitude =
        0.35 + // base sea level offset
        baseNoise * 0.25 + // noise variation
        mountainSpineMask(nx, ny) +
        chalkSouthMask(nx, ny) +
        easternLowlandsMask(nx, ny) +
        northernIceMask(ny) +
        waterLandsMask(nx, ny) +
        seaMask(nx, ny);

      // Add medium-scale variation for local hills and valleys
      const medNoise = layeredNoise(
        noise.noise2D,
        x + 1000,
        y + 1000,
        4,
        0.5,
        2.0,
        0.025
      );
      altitude += medNoise * 0.08;

      // Clamp
      altitude = Math.max(0, Math.min(1, altitude));

      // Determine geology from altitude and position
      const geology = classifyGeology(nx, ny, altitude, noise, x, y);

      row.push({
        altitude,
        geology,
        riverFlow: 0,
        isCoast: false,
        nx,
        ny,
      });
    }
    cells.push(row);
  }

  // Phase 2: Generate rivers
  generateRivers(cells, width, height);

  // Phase 3: Mark coastline
  markCoasts(cells, width, height);

  return { width, height, cells, seed };
}

function classifyGeology(
  nx: number,
  ny: number,
  altitude: number,
  noise: NoiseGenerator,
  gx: number,
  gy: number
): GeologyType {
  const seaLevel = 0.22;

  // Below sea level — water
  if (altitude < seaLevel) {
    return GeologyType.Water;
  }

  // Very close to sea level in the east — water-lands (partially submerged)
  if (altitude < seaLevel + 0.04 && nx > 0.65) {
    // Patchy — some land, some water
    const patchNoise = layeredNoise(
      noise.noise2D,
      gx + 5000,
      gy + 5000,
      3,
      0.5,
      2.0,
      0.04
    );
    if (patchNoise < -0.1) return GeologyType.Water;
  }

  // Far north — glacial debris
  if (ny > 0.85) {
    return GeologyType.Glacial;
  }
  // Transition zone
  if (ny > 0.78) {
    const glacialNoise = layeredNoise(
      noise.noise2D,
      gx + 3000,
      gy + 3000,
      3,
      0.5,
      2.0,
      0.02
    );
    if (glacialNoise > (0.85 - ny) * 8) return GeologyType.Glacial;
  }

  // Western mountains — granite at high altitude, slate on slopes
  if (nx < 0.35) {
    if (altitude > 0.55) return GeologyType.Granite;
    if (altitude > 0.42 && nx < 0.25) return GeologyType.Granite;
    if (altitude > 0.35 && nx < 0.3) {
      // Slate on the slopes
      const slateNoise = layeredNoise(
        noise.noise2D,
        gx + 2000,
        gy + 2000,
        3,
        0.5,
        2.0,
        0.03
      );
      return slateNoise > 0 ? GeologyType.Slate : GeologyType.Granite;
    }
  }

  // Far western peninsula — granite even at lower altitudes
  if (nx < 0.1 && ny < 0.4 && altitude > seaLevel + 0.02) {
    return GeologyType.Granite;
  }

  // Southern chalk
  if (ny < 0.3 && altitude > seaLevel + 0.02) {
    // Chalk dominates the south, but not at the lowest points
    if (nx > 0.15 && nx < 0.8) {
      if (altitude < 0.35) {
        // Low-lying south — mix of chalk and clay
        const mixNoise = layeredNoise(
          noise.noise2D,
          gx + 4000,
          gy + 4000,
          3,
          0.5,
          2.0,
          0.02
        );
        return mixNoise > 0.1 ? GeologyType.Chalk : GeologyType.Clay;
      }
      return GeologyType.Chalk;
    }
  }

  // Eastern lowlands — clay
  if (nx > 0.55 && altitude < 0.35) {
    return GeologyType.Clay;
  }

  // Central and transitional areas — limestone and sandstone
  if (altitude > 0.32 && altitude < 0.5) {
    const transNoise = layeredNoise(
      noise.noise2D,
      gx + 6000,
      gy + 6000,
      3,
      0.5,
      2.0,
      0.015
    );
    if (transNoise > 0.15) return GeologyType.Limestone;
    if (transNoise < -0.15) return GeologyType.Sandstone;
  }

  // Limestone in middle altitudes, particularly mid-country
  if (altitude > 0.3 && altitude < 0.45 && nx > 0.2 && nx < 0.6) {
    return GeologyType.Limestone;
  }

  // Default lowlands — clay
  if (altitude < 0.32) {
    return GeologyType.Clay;
  }

  // Default mid-altitude — sandstone
  if (altitude < 0.42) {
    const sNoise = layeredNoise(
      noise.noise2D,
      gx + 7000,
      gy + 7000,
      2,
      0.5,
      2.0,
      0.02
    );
    return sNoise > 0 ? GeologyType.Sandstone : GeologyType.Limestone;
  }

  // High ground defaults to granite
  return GeologyType.Granite;
}

function generateRivers(
  cells: TerrainCell[][],
  width: number,
  height: number
): void {
  // Flow accumulation: for each cell, trace downhill and accumulate flow
  const flow = Array.from({ length: height }, () => new Float32Array(width));

  // Initialise with rainfall proportional to altitude (higher = more rain)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cells[y][x].geology !== GeologyType.Water) {
        flow[y][x] = 0.5 + cells[y][x].altitude * 0.5;
      }
    }
  }

  // Sort cells by altitude, highest first
  const sorted: [number, number][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sorted.push([x, y]);
    }
  }
  sorted.sort((a, b) => cells[b[1]][b[0]].altitude - cells[a[1]][a[0]].altitude);

  // Flow accumulation — each cell flows to its lowest neighbour
  const dirs = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ];

  for (const [x, y] of sorted) {
    if (cells[y][x].geology === GeologyType.Water) continue;

    let lowestAlt = cells[y][x].altitude;
    let lowestX = -1;
    let lowestY = -1;

    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        if (cells[ny][nx].altitude < lowestAlt) {
          lowestAlt = cells[ny][nx].altitude;
          lowestX = nx;
          lowestY = ny;
        }
      }
    }

    if (lowestX >= 0) {
      flow[lowestY][lowestX] += flow[y][x];
    }
  }

  // Write flow values back to cells — threshold for visible river
  const riverThreshold = 80;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (flow[y][x] > riverThreshold && cells[y][x].geology !== GeologyType.Water) {
        cells[y][x].riverFlow = flow[y][x];
      }
    }
  }
}

function markCoasts(
  cells: TerrainCell[][],
  width: number,
  height: number
): void {
  const dirs = [
    [0, -1], [0, 1], [-1, 0], [1, 0],
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cells[y][x].geology !== GeologyType.Water) {
        for (const [dx, dy] of dirs) {
          const nx = x + dx;
          const ny = y + dy;
          if (
            nx >= 0 && nx < width && ny >= 0 && ny < height &&
            cells[ny][nx].geology === GeologyType.Water
          ) {
            cells[y][x].isCoast = true;
            break;
          }
        }
      }
    }
  }
}
TERRAIN

# --- Renderer ---
cat > src/renderer.ts << 'RENDERER'
import { TerrainMap } from "./terrain";
import { GEOLOGY_INFO, GeologyType } from "./geology";

export function renderTerrain(
  canvas: HTMLCanvasElement,
  terrain: TerrainMap
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const { width, height, cells } = terrain;
  canvas.width = width;
  canvas.height = height;

  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y][x];
      const idx = (y * width + x) * 4;

      // Get base colour from geology
      const geoInfo = GEOLOGY_INFO[cell.geology];
      const baseColor = hexToRgb(geoInfo.color);

      // Apply altitude shading — lighter at higher altitude, darker at lower
      // Subtle effect to show hills and valleys within geological zones
      const altShade = cell.geology === GeologyType.Water
        ? 1.0
        : 0.7 + cell.altitude * 0.6;

      let r = baseColor.r * altShade;
      let g = baseColor.g * altShade;
      let b = baseColor.b * altShade;

      // Water depth shading — deeper = darker
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

      // River overlay — blue-dark, width varies with flow
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

  ctx.putImageData(imageData, 0, 0);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return { r: 128, g: 128, b: 128 };
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  };
}

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
RENDERER

# --- Main entry point ---
cat > src/main.ts << 'MAIN'
import { createSeededNoise } from "./noise";
import { generateTerrain, TerrainMap } from "./terrain";
import { GEOLOGY_INFO } from "./geology";
import { renderTerrain, renderLegend } from "./renderer";

// --- State ---
let currentTerrain: TerrainMap | null = null;

// --- Map dimensions ---
// Roughly 300 miles east-west by 600 miles north-south
// At 1 pixel per ~1 mile, that's 300x600
// We'll use a slightly larger canvas and scale for readability
const MAP_WIDTH = 300;
const MAP_HEIGHT = 500;

// --- UI Elements ---
const canvas = document.getElementById("terrain") as HTMLCanvasElement;
const seedInput = document.getElementById("seed") as HTMLInputElement;
const generateBtn = document.getElementById("generate") as HTMLButtonElement;
const randomBtn = document.getElementById("random") as HTMLButtonElement;
const legendContainer = document.getElementById("legend") as HTMLElement;
const cursorInfo = document.getElementById("cursor-info") as HTMLElement;

// --- Render legend ---
renderLegend(legendContainer);

// --- Generate terrain ---
function generate(seed: string): void {
  const startTime = performance.now();

  const noise = createSeededNoise(seed);
  currentTerrain = generateTerrain(noise, MAP_WIDTH, MAP_HEIGHT, seed);
  renderTerrain(canvas, currentTerrain);

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

// --- Cursor inspection ---
canvas.addEventListener("mousemove", (e) => {
  if (!currentTerrain) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = currentTerrain.width / rect.width;
  const scaleY = currentTerrain.height / rect.height;
  const x = Math.floor((e.clientX - rect.left) * scaleX);
  const y = Math.floor((e.clientY - rect.top) * scaleY);

  if (x >= 0 && x < currentTerrain.width && y >= 0 && y < currentTerrain.height) {
    const cell = currentTerrain.cells[y][x];
    const info = GEOLOGY_INFO[cell.geology];
    const altMetres = Math.round(cell.altitude * 1200); // Rough scale: 1.0 = ~1200m
    const river = cell.riverFlow > 0 ? " · River" : "";
    const coast = cell.isCoast ? " · Coast" : "";

    cursorInfo.textContent =
      `${info.label} · ${altMetres}m${river}${coast} — ${info.description}`;
  }
});

canvas.addEventListener("mouseleave", () => {
  cursorInfo.textContent = "";
});

// --- Initial generation ---
generate("barrow");
MAIN

# --- GitHub Pages deployment workflow ---
mkdir -p .github/workflows

cat > .github/workflows/deploy.yml << 'DEPLOY'
name: Deploy to GitHub Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "npm"
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build
      - name: Setup Pages
        uses: actions/configure-pages@v4
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: "dist"

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
DEPLOY

# --- .gitignore ---
cat > .gitignore << 'GITIGNORE'
node_modules
dist
*.local
GITIGNORE

# --- Install and test ---
echo ""
echo "=== Setup complete ==="
echo ""
echo "Now run:"
echo "  npm install"
echo "  npm run dev"
echo ""
echo "Then open the URL that Vite prints (usually http://localhost:5173/barrow-terrain/)"
echo "You should see a generated landscape map."
echo ""
echo "When you're happy, commit and push to deploy to GitHub Pages:"
echo "  git add ."
echo '  git commit -m "Initial terrain generator"'
echo "  git push"
echo ""
