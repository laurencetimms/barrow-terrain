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

// ---------------------------------------------------------------------------
// Curve utilities
// ---------------------------------------------------------------------------

/** Minimum distance from point (px, py) to line segment a→b. */
function distToSegment(
  ax: number, ay: number,
  bx: number, by: number,
  px: number, py: number
): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Minimum distance from point to a polyline. */
function distToCurve(
  points: readonly [number, number][],
  px: number,
  py: number
): number {
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const d = distToSegment(
      points[i][0], points[i][1],
      points[i + 1][0], points[i + 1][1],
      px, py
    );
    if (d < min) min = d;
  }
  return min;
}

/**
 * Linearly interpolated y of a polyline at x.
 * Points must be sorted ascending by x. Extrapolates beyond endpoints.
 */
function curveYAtX(points: readonly [number, number][], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 0; i < points.length - 1; i++) {
    if (x <= points[i + 1][0]) {
      const t = (x - points[i][0]) / (points[i + 1][0] - points[i][0]);
      return points[i][1] * (1 - t) + points[i + 1][1] * t;
    }
  }
  return points[points.length - 1][1];
}

// ---------------------------------------------------------------------------
// Feature curves  (all in normalised nx/ny space, 0..1)
// nx = 0 west, 1 east;  ny = 0 south, 1 north
// ---------------------------------------------------------------------------

/**
 * Mountain spine — a curved path running broadly N–S through the western third.
 * The granite zone is a noise-warped distance field around this curve.
 */
const SPINE_CURVE: readonly [number, number][] = [
  [0.21, 0.02],
  [0.19, 0.18],
  [0.23, 0.35],
  [0.21, 0.52],
  [0.26, 0.68],
  [0.20, 0.84],
  [0.22, 0.97],
];

/**
 * Chalk escarpment — gently curved arc running broadly E–W across the south.
 * Points sorted by x so curveYAtX works correctly.
 * Geology south of this arc is chalk/clay; the arc itself is the crest.
 */
const CHALK_CURVE: readonly [number, number][] = [
  [0.10, 0.30],
  [0.25, 0.26],
  [0.42, 0.21],
  [0.60, 0.19],
  [0.78, 0.23],
];

/** Fault valley 1 — diagonal NW→SE depression cutting through the highlands. */
const FAULT1_CURVE: readonly [number, number][] = [
  [0.09, 0.75],
  [0.22, 0.61],
  [0.34, 0.48],
];

/** Fault valley 2 — shallower diagonal through the central uplands. */
const FAULT2_CURVE: readonly [number, number][] = [
  [0.19, 0.42],
  [0.33, 0.30],
  [0.48, 0.19],
];

/** Estuary — one deep drowned valley cutting inland from the west coast. */
const ESTUARY_CURVE: readonly [number, number][] = [
  [0.00, 0.365],
  [0.05, 0.362],
  [0.11, 0.357],
  [0.17, 0.351],
];

/** Sea loch 1 — northern fjord-like inlet where mountains meet the coast. */
const SEALOCH1_CURVE: readonly [number, number][] = [
  [0.00, 0.792],
  [0.07, 0.778],
  [0.14, 0.760],
];

/** Sea loch 2 — mid-west narrow inlet between high peninsulas. */
const SEALOCH2_CURVE: readonly [number, number][] = [
  [0.00, 0.567],
  [0.07, 0.558],
  [0.13, 0.548],
];

// ---------------------------------------------------------------------------
// Noise warp helper
// ---------------------------------------------------------------------------

function warpCoord(
  noise2D: (x: number, y: number) => number,
  x: number, y: number,
  offsetX: number, offsetY: number,
  scale: number,
  strength: number
): number {
  return layeredNoise(noise2D, x + offsetX, y + offsetY, 4, 0.5, 2.0, scale) * strength;
}

// ---------------------------------------------------------------------------
// Altitude generation
// ---------------------------------------------------------------------------

function generateAltitude(
  noise: NoiseGenerator,
  nx: number,
  ny: number,
  gx: number,
  gy: number
): number {
  const { noise2D } = noise;

  // Global coordinate warp — makes all macro-boundaries organic
  const warpX = warpCoord(noise2D, gx, gy, 7777, 3333, 0.006, 0.06);
  const warpY = warpCoord(noise2D, gx, gy, 4444, 8888, 0.006, 0.06);
  const wnx = nx + warpX;
  const wny = ny + warpY;

  // ── Mountain spine (distance field from curved path) ─────────────────────
  // Extra local warp gives the spine edge an irregular, blobby outline
  const spineWarpX = warpCoord(noise2D, gx, gy, 1100, 2200, 0.009, 0.05);
  const spineWarpY = warpCoord(noise2D, gx, gy, 3300, 4400, 0.009, 0.05);
  const spineDist = distToCurve(SPINE_CURVE, wnx + spineWarpX, wny + spineWarpY);
  const spineWidth = 0.09 + layeredNoise(noise2D, gy * 0.5, 600, 3, 0.5, 2.0, 0.008) * 0.035;
  let spineHeight = Math.max(0, 1 - (spineDist / spineWidth) ** 2);
  const spineHeightVar = 0.80 + layeredNoise(noise2D, gy, 700, 3, 0.5, 2.0, 0.012) * 0.30;
  spineHeight *= spineHeightVar;
  // Fade at the southern extreme only — ice handles the north
  const spineFadeSouth = Math.min(1, wny / 0.10);
  spineHeight *= spineFadeSouth * 0.58;

  // ── Southern chalk escarpment (distance from chalk curve) ─────────────────
  const chalkDist = distToCurve(CHALK_CURVE, wnx, wny);
  // Boost near the crest of the escarpment
  const escarpBoost = Math.max(0, 1 - chalkDist / 0.05) * 0.14;
  // General southern uplift: higher closer to (and south of) the chalk curve
  const chalkRefY = curveYAtX(CHALK_CURVE, wnx);
  const southRidge = Math.max(0, (chalkRefY - wny) / Math.max(0.01, chalkRefY)) * 0.15;
  const escarpWestFade = Math.min(1, wnx / 0.12);
  const southAlt = (southRidge + escarpBoost) * escarpWestFade;

  // ── Fault valleys (diagonal linear depressions) ───────────────────────────
  const fault1Dist = distToCurve(FAULT1_CURVE, wnx, wny);
  const fault2Dist = distToCurve(FAULT2_CURVE, wnx, wny);
  const faultWidth = 0.038;
  const fault1Depth = Math.max(0, 1 - fault1Dist / faultWidth) ** 1.5 * 0.20;
  const fault2Depth = Math.max(0, 1 - fault2Dist / faultWidth) ** 1.5 * 0.13;

  // ── Drowned valley features (estuary + sea lochs) ─────────────────────────
  // These override normal altitude to ensure water always fills the channels
  const estDist = distToCurve(ESTUARY_CURVE, wnx, wny);
  const sl1Dist = distToCurve(SEALOCH1_CURVE, wnx, wny);
  const sl2Dist = distToCurve(SEALOCH2_CURVE, wnx, wny);
  const estDepth = Math.max(0, 1 - estDist / 0.022) ** 1.5 * 0.52;
  const sl1Depth = Math.max(0, 1 - sl1Dist / 0.026) ** 1.5 * 0.54;
  const sl2Depth = Math.max(0, 1 - sl2Dist / 0.026) ** 1.5 * 0.50;

  // ── Eastern depression ────────────────────────────────────────────────────
  const eastDrop = Math.max(0, (wnx - 0.5) / 0.5);
  const eastVar = layeredNoise(noise2D, gx, gy, 3, 0.5, 2.0, 0.012) * 0.06;
  const eastAlt = -(eastDrop * 0.25 + eastDrop * eastVar);

  // ── Water-lands (far east) ────────────────────────────────────────────────
  const waterLandsEast = Math.max(0, (wnx - 0.72) / 0.28);
  const waterLandsLat = 1 - Math.pow((wny - 0.45) * 2.2, 2) * 0.5;
  const waterLandsAlt = -waterLandsEast * Math.max(0, waterLandsLat) * 0.30;

  // ── Ice margin depression ─────────────────────────────────────────────────
  // Slight basin from isostatic loading under the ice sheet
  const iceMargin = Math.max(0, (wny - 0.84) / 0.16);
  const iceAlt = -iceMargin * 0.10;

  // ── West coast (rugged, multi-scale — peninsulas, islands, sea lochs) ─────
  // Three noise scales: large = peninsulas/headlands, medium = coves,
  // fine = rock stacks / skerry outlines
  const coastLarge = layeredNoise(noise2D, gy,        901, 4, 0.50, 2.0, 0.016) * 0.055;
  const coastMed   = layeredNoise(noise2D, gy + 3000, 901, 3, 0.60, 2.0, 0.045) * 0.028;
  const coastFine  = layeredNoise(noise2D, gy + 6000, 901, 3, 0.60, 2.0, 0.110) * 0.013;
  const westCoastLine = 0.055 + coastLarge + coastMed + coastFine;
  const westCoast = Math.max(0, (westCoastLine - wnx) / 0.04);

  // South coast
  const southCoast = Math.max(0, (0.05 - wny) / 0.05);
  const seaAlt = -(southCoast + westCoast) * 0.40;

  // ── Base noise ────────────────────────────────────────────────────────────
  const largeNoise = layeredNoise(noise2D, gx,        gy,        6, 0.5, 2.0, 0.007) * 0.20;
  const medNoise   = layeredNoise(noise2D, gx + 1000, gy + 1000, 4, 0.5, 2.0, 0.022) * 0.08;
  const smallNoise = layeredNoise(noise2D, gx + 2000, gy + 2000, 3, 0.5, 2.0, 0.060) * 0.03;

  // ── Combine ───────────────────────────────────────────────────────────────
  const altitude =
    0.33
    + largeNoise + medNoise + smallNoise
    + spineHeight
    + southAlt
    + eastAlt + waterLandsAlt
    + iceAlt
    + seaAlt
    - fault1Depth - fault2Depth
    - estDepth - sl1Depth - sl2Depth;

  return Math.max(0, Math.min(1, altitude));
}

// ---------------------------------------------------------------------------
// Geology classification
// ---------------------------------------------------------------------------

function classifyGeology(
  nx: number,
  ny: number,
  altitude: number,
  noise: NoiseGenerator,
  gx: number,
  gy: number
): GeologyType {
  const { noise2D } = noise;
  const seaLevel = 0.22;

  if (altitude < seaLevel) return GeologyType.Water;

  // Water-lands — patchy water/land near sea level in the east
  if (altitude < seaLevel + 0.04 && nx > 0.62) {
    const patchNoise = layeredNoise(noise2D, gx + 5000, gy + 5000, 4, 0.5, 2.0, 0.035);
    if (patchNoise < -0.05) return GeologyType.Water;
  }

  // ── Ice sheet (altitude-threshold varying with latitude) ─────────────────
  // Ice sits on high ground and follows terrain contours — not a flat curtain.
  // As latitude increases, the ice descends to lower altitudes.
  if (ny > 0.68) {
    const iceWarp = layeredNoise(noise2D, gx + 9000, gy + 9000, 4, 0.5, 2.0, 0.014) * 0.10;

    if (ny > 0.72) {
      // Pure glacial: altitude above the ice line
      const iceT = (ny - 0.72) / 0.28; // 0..1 across the glacial zone
      const iceAltThreshold = Math.max(0.05, 0.78 - iceT * 0.74 + iceWarp);
      if (altitude > iceAltThreshold) return GeologyType.Glacial;
    }

    // Glacial debris: moraines, erratics, meltwater channels — patchy fringe
    // south of and at the lower margin of the ice
    const debrisT = (ny - 0.68) / 0.32;
    const debrisThreshold = Math.max(0.12, 0.86 - debrisT * 0.62 + iceWarp);
    if (altitude > debrisThreshold) {
      const debrisNoise = layeredNoise(noise2D, gx + 3200, gy + 3200, 3, 0.5, 2.0, 0.025);
      if (debrisNoise > 0) return GeologyType.Glacial;
    }
  }

  // ── Granite zone — noise-warped distance field around the spine curve ─────
  // Heavy warp gives a blobby outline with fingers extending along ridges and
  // slate-filled valleys penetrating back inward.
  const graniteWarpX = warpCoord(noise2D, gx, gy, 5500, 6600, 0.010, 0.07);
  const graniteWarpY = warpCoord(noise2D, gx, gy, 7700, 8800, 0.010, 0.07);
  const spineDist = distToCurve(SPINE_CURVE, nx + graniteWarpX, ny + graniteWarpY);

  // Large-scale blob noise widens and narrows the granite body irregularly
  const graniteBlob = layeredNoise(noise2D, gx + 9100, gy + 9100, 5, 0.55, 2.0, 0.011) * 0.065;
  // Higher altitude → wider granite envelope (summits are always granite)
  const graniteZoneWidth = 0.075 + graniteBlob + Math.max(0, altitude - 0.32) * 0.18;

  if (spineDist < graniteZoneWidth && altitude > 0.30) {
    // Slate-filled valleys penetrate into the granite body along depressions
    const valleyNoise = layeredNoise(noise2D, gx + 9200, gy + 9200, 4, 0.5, 2.0, 0.015);
    if (valleyNoise < -0.28 && altitude < 0.44) return GeologyType.Slate;
    if (altitude > 0.42) return GeologyType.Granite;
    return valleyNoise > -0.05 ? GeologyType.Granite : GeologyType.Slate;
  }

  // Far western peninsula — granite at lower altitudes (like a granite headland)
  const penBoundary = 0.11 + layeredNoise(noise2D, gy + 4300, gx + 4300, 3, 0.5, 2.0, 0.015) * 0.03;
  if (nx < penBoundary && ny < 0.38 && altitude > seaLevel + 0.02) {
    return GeologyType.Granite;
  }

  // ── Fault zones — shattered rock exposed along diagonal fault valleys ─────
  const fault1Dist = distToCurve(FAULT1_CURVE, nx, ny);
  const fault2Dist = distToCurve(FAULT2_CURVE, nx, ny);
  if (Math.min(fault1Dist, fault2Dist) < 0.028 && altitude > seaLevel + 0.04) {
    const faultNoise = layeredNoise(noise2D, gx + 8000, gy + 8000, 3, 0.5, 2.0, 0.030);
    if (faultNoise > -0.20) return GeologyType.Slate;
  }

  // ── Southern chalk (south of the escarpment curve) ────────────────────────
  const chalkRefY = curveYAtX(CHALK_CURVE, nx);
  const chalkWestEdge = 0.12 + layeredNoise(noise2D, gx + 4500, gy + 4500, 3, 0.5, 2.0, 0.015) * 0.04;
  const chalkDist = distToCurve(CHALK_CURVE, nx, ny);

  if (ny < chalkRefY && nx > chalkWestEdge && altitude > seaLevel + 0.02) {
    if (chalkDist < 0.035) return GeologyType.Chalk; // escarpment crest
    if (altitude > 0.28) return GeologyType.Chalk;
    const mixNoise = layeredNoise(noise2D, gx + 4600, gy + 4600, 3, 0.5, 2.0, 0.020);
    return mixNoise > 0 ? GeologyType.Chalk : GeologyType.Clay;
  }

  // ── Eastern clay lowlands ─────────────────────────────────────────────────
  const clayWestEdge = 0.48 + layeredNoise(noise2D, gx + 4700, gy + 4700, 4, 0.5, 2.0, 0.010) * 0.08;
  if (nx > clayWestEdge && altitude < 0.34) return GeologyType.Clay;

  // ── Central transitional zone — limestone dales and sandstone moors ───────
  const transNoise = layeredNoise(noise2D, gx + 6000, gy + 6000, 4, 0.5, 2.0, 0.013);

  if (altitude > 0.30 && altitude < 0.46) {
    if (transNoise > 0.10) return GeologyType.Limestone;
    if (transNoise < -0.10) return GeologyType.Sandstone;
    return GeologyType.Limestone;
  }

  if (altitude > 0.25 && altitude < 0.35) {
    if (transNoise > 0.15) return GeologyType.Limestone;
    if (transNoise < -0.15) return GeologyType.Sandstone;
    return GeologyType.Clay;
  }

  if (altitude < 0.30) return GeologyType.Clay;

  if (altitude < 0.42) {
    const sNoise = layeredNoise(noise2D, gx + 7000, gy + 7000, 3, 0.5, 2.0, 0.018);
    return sNoise > 0 ? GeologyType.Sandstone : GeologyType.Limestone;
  }

  return GeologyType.Granite;
}

// ---------------------------------------------------------------------------
// River generation
// ---------------------------------------------------------------------------

function generateRivers(
  cells: TerrainCell[][],
  width: number,
  height: number
): void {
  const flow = Array.from({ length: height }, () => new Float32Array(width));

  // Initialise with rainfall proportional to altitude
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
  sorted.sort(
    (a, b) => cells[b[1]][b[0]].altitude - cells[a[1]][a[0]].altitude
  );

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

  const riverThreshold = 80;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (
        flow[y][x] > riverThreshold &&
        cells[y][x].geology !== GeologyType.Water
      ) {
        cells[y][x].riverFlow = flow[y][x];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Coast marking
// ---------------------------------------------------------------------------

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
          const cx = x + dx;
          const cy = y + dy;
          if (
            cx >= 0 && cx < width && cy >= 0 && cy < height &&
            cells[cy][cx].geology === GeologyType.Water
          ) {
            cells[y][x].isCoast = true;
            break;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main generation function
// ---------------------------------------------------------------------------

export function generateTerrain(
  noise: NoiseGenerator,
  width: number,
  height: number,
  seed: string
): TerrainMap {
  const cells: TerrainCell[][] = [];

  for (let y = 0; y < height; y++) {
    const row: TerrainCell[] = [];
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const ny = 1 - y / height;

      const altitude = generateAltitude(noise, nx, ny, x, y);
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

  generateRivers(cells, width, height);
  markCoasts(cells, width, height);

  return { width, height, cells, seed };
}
