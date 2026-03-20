import { NoiseGenerator, layeredNoise } from "./noise";
import { GeologyType } from "./geology";

export type WaterLandsSubType =
  | 'openWater'
  | 'reedBed'
  | 'mudFlat'
  | 'raisedIsland'
  | 'carrWoodland'
  | 'tidalChannel';

export interface TerrainCell {
  altitude: number; // 0..1 where 0 is sea level, 1 is highest peak
  geology: GeologyType;
  riverFlow: number; // accumulated water flow, 0 = no river
  isCoast: boolean;
  // Normalised position in the world (0..1)
  nx: number; // 0 = west, 1 = east
  ny: number; // 0 = south, 1 = north
  /** Sub-type within the eastern water-lands zone. Only set for cells in that zone. */
  waterLandsType?: WaterLandsSubType;
}

export interface TerrainMap {
  width: number;
  height: number;
  cells: TerrainCell[][];
  seed: string;
  /** Pre-baked vegetation noise, indexed [y * width + x]. Set by bakeVegetationNoise(). */
  vegNoise?: Float32Array;
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
 * Mountain spine — curved path running SW→NNE through the western portion,
 * bending further northeast in the upper section.
 */
const SPINE_CURVE: readonly [number, number][] = [
  [0.18, 0.02],
  [0.20, 0.16],
  [0.22, 0.30],
  [0.26, 0.44],
  [0.30, 0.57],
  [0.34, 0.70],
  [0.38, 0.83],
  [0.40, 0.95],
];

/**
 * Spine branch — splits NE from the mid-spine, extending into the central
 * highlands as a secondary ridge.
 */
const SPINE_BRANCH: readonly [number, number][] = [
  [0.30, 0.57],
  [0.38, 0.64],
  [0.47, 0.71],
  [0.55, 0.78],
  [0.58, 0.84],
];

/**
 * Chalk escarpment — S-curve running through the southern portion,
 * curving independently of the spine. Points sorted by x so curveYAtX works.
 */
const CHALK_CURVE: readonly [number, number][] = [
  [0.10, 0.28],
  [0.22, 0.24],
  [0.35, 0.20],
  [0.50, 0.22],
  [0.62, 0.26],
  [0.75, 0.30],
  [0.85, 0.28],
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

  // ── Spine branch — secondary ridge splitting NE from mid-spine ────────────
  const branchWarpX = warpCoord(noise2D, gx, gy, 1150, 2250, 0.009, 0.05);
  const branchWarpY = warpCoord(noise2D, gx, gy, 3350, 4450, 0.009, 0.05);
  const branchDist = distToCurve(SPINE_BRANCH, wnx + branchWarpX, wny + branchWarpY);
  const branchWidth = 0.07 + layeredNoise(noise2D, gy * 0.5, 650, 3, 0.5, 2.0, 0.008) * 0.030;
  let branchHeight = Math.max(0, 1 - (branchDist / branchWidth) ** 2);
  branchHeight *= (0.70 + layeredNoise(noise2D, gy, 750, 3, 0.5, 2.0, 0.012) * 0.25) * 0.48;
  branchHeight *= spineFadeSouth;

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

  // ── Great Sandbank (fixed landmark island within the water-lands) ─────────
  // Centred roughly at (nx 0.85, ny 0.45). Noise-warped radius gives an
  // irregular, believable outline. Large enough to be visible at coarse zoom.
  const sandDx = wnx - 0.855;
  const sandDy = wny - 0.455;
  const sandWarpR = layeredNoise(noise2D, gx + 15000, gy + 15000, 3, 0.5, 2.0, 0.030) * 0.035;
  const sandRadius = 0.060 + sandWarpR;
  const sandDistSq = sandDx * sandDx + sandDy * sandDy;
  const sandBump = Math.max(0, 1 - sandDistSq / (sandRadius * sandRadius)) * 0.14;

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
    + Math.max(spineHeight, branchHeight)
    + southAlt
    + eastAlt + waterLandsAlt
    + sandBump
    + iceAlt
    + seaAlt
    - fault1Depth - fault2Depth
    - estDepth - sl1Depth - sl2Depth;

  return Math.max(0, Math.min(1, altitude));
}

// ---------------------------------------------------------------------------
// Water-lands zone definition
// ---------------------------------------------------------------------------

/**
 * Returns true if the given normalised position (nx, ny) falls within the
 * eastern water-lands zone. The zone is bounded:
 *   West  — a noise-warped line around nx 0.62-0.70
 *   South — noise-warped around ny 0.08 (south of this = normal chalk coast)
 *   North — noise-warped around ny 0.66 (north of this = normal glacial coast)
 *   East  — open sea edge
 *
 * gx/gy are the raw grid coordinates used for noise sampling (same domain
 * as the rest of the noise in this module).
 */
function isInWaterLandsZone(
  nx: number, ny: number,
  noise2D: (x: number, y: number) => number,
  gx: number, gy: number
): boolean {
  const southWarp = layeredNoise(noise2D, gx * 0.008 + 13000, gy * 0.008 + 13000, 3, 0.5, 2.0, 1.0) * 0.022;
  const northWarp = layeredNoise(noise2D, gx * 0.008 + 14000, gy * 0.008 + 14000, 3, 0.5, 2.0, 1.0) * 0.022;
  if (ny < 0.08 + southWarp || ny > 0.66 + northWarp) return false;

  // West boundary — matches the waterLandsBoundary used in classifyGeology
  const westBoundary = 0.62
    + layeredNoise(noise2D, gy * 0.008 + 11000, gx * 0.008 + 11000, 3, 0.5, 2.0, 1.0) * 0.06
    + warpCoord(noise2D, gx, gy, 11100, 11200, 0.007, 0.05);
  return nx > westBoundary;
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
  // Boundary noise-warped so the eastern coastline is ragged, not a straight meridian
  const waterLandsBoundary = 0.62
    + layeredNoise(noise2D, gy * 0.008 + 11000, gx * 0.008 + 11000, 3, 0.5, 2.0, 1.0) * 0.06
    + warpCoord(noise2D, gx, gy, 11100, 11200, 0.007, 0.05);
  if (altitude < seaLevel + 0.04 && nx > waterLandsBoundary) {
    const patchNoise = layeredNoise(noise2D, gx + 5000, gy + 5000, 4, 0.5, 2.0, 0.035);
    if (patchNoise < -0.05) return GeologyType.Water;
  }

  // ── Ice sheet (equilibrium altitude with hard southern cutoff) ───────────
  // The equilibrium line — above which ice persists — rises steeply as
  // latitude decreases, modelled as an exponential. South of the cutoff
  // latitude, the line effectively reaches infinity: no terrain is cold
  // enough for ice, regardless of altitude.
  //
  // Separate noise warps on the cutoff location and the equilibrium altitude
  // give the southern ice limit a ragged, terrain-following character.
  const iceWarpCutoff = layeredNoise(noise2D, gx + 9100, gy + 9100, 3, 0.5, 2.0, 0.018);
  const iceWarpLine   = layeredNoise(noise2D, gx + 9000, gy + 9000, 4, 0.5, 2.0, 0.015);

  // Hard southern limit — noise-warped so the boundary is ragged (±0.06)
  const iceLatCutoff = 0.65 + iceWarpCutoff * 0.06;

  if (ny >= iceLatCutoff) {
    // Distance above the cutoff (0 at cutoff, up to ~0.35 at the far north)
    const latAbove = ny - iceLatCutoff;

    // Equilibrium altitude: very high just above the cutoff (only the most
    // extreme peaks get ice near the southern limit), dropping steeply as
    // latitude increases so the far north is broadly glaciated.
    // exp(-8 × latAbove): at latAbove=0 → 0.28+0.72=1.0, at latAbove=0.35 → ~0.32
    const equilibriumAlt = 0.28 + 0.72 * Math.exp(-latAbove * 8) + iceWarpLine * 0.07;

    if (altitude > equilibriumAlt) return GeologyType.Ice;

    // Glacial debris: patchy fringe just below the equilibrium line
    if (altitude > equilibriumAlt - 0.10) {
      const debrisNoise = layeredNoise(noise2D, gx + 3200, gy + 3200, 3, 0.5, 2.0, 0.025);
      if (debrisNoise > 0) return GeologyType.Glacial;
    }
  }

  // ── Granite zone — noise-warped distance field around the spine + branch ──
  // Heavy warp gives a blobby outline with fingers extending along ridges and
  // slate-filled valleys penetrating back inward.
  const graniteWarpX = warpCoord(noise2D, gx, gy, 5500, 6600, 0.010, 0.12);
  const graniteWarpY = warpCoord(noise2D, gx, gy, 7700, 8800, 0.010, 0.12);
  const spineDistG  = distToCurve(SPINE_CURVE,  nx + graniteWarpX, ny + graniteWarpY);
  const branchDistG = distToCurve(SPINE_BRANCH, nx + graniteWarpX, ny + graniteWarpY);
  const combinedSpineDistG = Math.min(spineDistG, branchDistG);

  // Two-scale blob noise widens and narrows the granite body irregularly
  const graniteBlob  = layeredNoise(noise2D, gx + 9100, gy + 9100, 5, 0.55, 2.0, 0.011) * 0.085;
  const graniteBlob2 = layeredNoise(noise2D, gx + 9300, gy + 9300, 4, 0.60, 2.0, 0.018) * 0.045;
  // Higher altitude → wider granite envelope (summits are always granite)
  const graniteZoneWidth = 0.075 + graniteBlob + graniteBlob2 + Math.max(0, altitude - 0.32) * 0.22;

  if (combinedSpineDistG < graniteZoneWidth && altitude > 0.30) {
    // Slate-filled valleys penetrate into the granite body along depressions
    const valleyNoise = layeredNoise(noise2D, gx + 9200, gy + 9200, 4, 0.5, 2.0, 0.015);
    if (valleyNoise < -0.28 && altitude < 0.44) return GeologyType.Slate;
    if (altitude > 0.42) return GeologyType.Granite;
    return valleyNoise > -0.05 ? GeologyType.Granite : GeologyType.Slate;
  }

  // Far western peninsula — granite at lower altitudes (like a granite headland)
  const penBoundary = 0.11 + layeredNoise(noise2D, gy + 4300, gx + 4300, 3, 0.5, 2.0, 0.015) * 0.03;
  const penLatBoundary = 0.38
    + layeredNoise(noise2D, gx * 0.010 + 12000, gy * 0.010 + 12000, 3, 0.5, 2.0, 1.0) * 0.05
    + warpCoord(noise2D, gx, gy, 12100, 12200, 0.008, 0.04);
  if (nx < penBoundary && ny < penLatBoundary && altitude > seaLevel + 0.02) {
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
// Coastal geology correction
// ---------------------------------------------------------------------------

/**
 * Post-processing pass: coastal cells misclassified as Clay (due to the
 * low-altitude fallback in classifyGeology) are overridden with the dominant
 * hard geology found inland within a short radius. This ensures chalk cliffs,
 * granite headlands, limestone coasts, etc. appear at the shoreline rather
 * than a uniform clay transition everywhere.
 *
 * Only Clay cells on the coast are touched — cells that are naturally coastal
 * clay (eastern lowlands, glacial forelands) have no hard geology nearby and
 * are left unchanged.
 */
function fixCoastalGeology(
  cells: TerrainCell[][],
  width: number,
  height: number,
  noise: NoiseGenerator,
  coarseWidth: number,
  coarseHeight: number
): void {
  // Geology types that can override a misclassified coastal clay cell.
  // Glacial is intentionally excluded — glacial debris shores are correctly
  // low and gradual and should stay as-is.
  const HARD_GEOS: ReadonlySet<GeologyType> = new Set([
    GeologyType.Granite,
    GeologyType.Slate,
    GeologyType.Chalk,
    GeologyType.Limestone,
    GeologyType.Sandstone,
  ]);

  const RADIUS = 8;
  const { noise2D } = noise;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!cells[y][x].isCoast) continue;
      if (cells[y][x].geology !== GeologyType.Clay) continue;

      // Water-lands zone: clay all the way to the water's edge — leave as-is.
      const { nx, ny } = cells[y][x];
      const gx = nx * coarseWidth;
      const gy = (1 - ny) * coarseHeight;
      if (isInWaterLandsZone(nx, ny, noise2D, gx, gy)) continue;

      // Tally hard-geology cells within the radius, weighting closer cells
      // more heavily so the geology directly behind this coastal cell wins
      // over distant geology on a different part of the coast.
      const scores = new Map<GeologyType, number>();
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          const nx2 = x + dx, ny2 = y + dy;
          if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
          const dist = Math.hypot(dx, dy);
          if (dist > RADIUS) continue;
          const geo = cells[ny2][nx2].geology;
          if (!HARD_GEOS.has(geo)) continue;
          scores.set(geo, (scores.get(geo) ?? 0) + 1 / (1 + dist));
        }
      }

      if (scores.size === 0) continue; // naturally clay coast — leave it

      let best: GeologyType = GeologyType.Clay;
      let bestScore = 0;
      for (const [geo, score] of scores) {
        if (score > bestScore) { bestScore = score; best = geo; }
      }
      cells[y][x].geology = best;
    }
  }
}

// ---------------------------------------------------------------------------
// Water-lands sub-type classification
// ---------------------------------------------------------------------------

/**
 * Post-processing pass: cells within the eastern water-lands zone are
 * classified into one of several sub-types (openWater, reedBed, mudFlat,
 * raisedIsland, carrWoodland, tidalChannel) using multiple noise layers
 * at different scales and an east-west wetness gradient.
 *
 * coarseWidth/coarseHeight are the dimensions of the coarse map — used to
 * convert normalised nx/ny back into grid coordinates for noise sampling
 * (which uses the same gx/gy domain as the rest of terrain generation).
 */
function classifyWaterLands(
  cells: TerrainCell[][],
  width: number,
  height: number,
  noise: NoiseGenerator,
  coarseWidth: number,
  coarseHeight: number
): void {
  const { noise2D } = noise;
  const seaLevel = 0.22;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y][x];
      const { nx, ny } = cell;
      const gx = nx * coarseWidth;
      const gy = (1 - ny) * coarseHeight;

      if (!isInWaterLandsZone(nx, ny, noise2D, gx, gy)) continue;
      if (cell.geology !== GeologyType.Clay && cell.geology !== GeologyType.Water) continue;

      // E-W gradient: 0 at the western boundary (~0.65), 1 fully east (~0.92)
      const ewWetness = Math.min(1, Math.max(0, (nx - 0.65) / 0.27));

      // Large-scale (broad bodies of water vs land masses)
      const largeNoise = layeredNoise(noise2D, gx + 20000, gy + 20000, 4, 0.5, 2.0, 0.018);
      // Medium-scale (reed/mud/channel mosaic — the visual signature of the water-lands)
      const medNoise   = layeredNoise(noise2D, gx + 21000, gy + 21000, 4, 0.5, 2.0, 0.052);
      // Fine-scale (smallest features: channels between reed clumps, small pools)
      const fineNoise  = layeredNoise(noise2D, gx + 22000, gy + 22000, 3, 0.5, 2.0, 0.130);

      const altAboveSea = cell.altitude - seaLevel;

      if (cell.geology === GeologyType.Water) {
        // Tidal channels: narrow troughs detected by aligned medium + fine troughs,
        // more common in the middle zone, rare in the deepest open water.
        if (medNoise < -0.30 && fineNoise < -0.20 && ewWetness < 0.85) {
          cell.waterLandsType = 'tidalChannel';
        } else {
          cell.waterLandsType = 'openWater';
        }
      } else {
        // Clay cells — classify by altitude above sea level + noise texture
        // Combined wetness: higher ewWetness + higher largeNoise = wetter interior
        const wetScore = largeNoise * 0.45 + ewWetness * 0.40 + medNoise * 0.15;

        if (altAboveSea < 0.013) {
          // Just above sea: mud flat or reed bed
          cell.waterLandsType = medNoise > 0.08 ? 'reedBed' : 'mudFlat';
        } else if (altAboveSea < 0.030) {
          // Reed beds dominant here; mud at lower-wetness patches
          cell.waterLandsType = wetScore < -0.12 ? 'mudFlat' : 'reedBed';
        } else if (altAboveSea < 0.060) {
          // Transition zone: carr woodland on wetter western margins and
          // larger interior land masses; reed elsewhere
          if (nx < 0.72 || largeNoise > 0.18) {
            cell.waterLandsType = 'carrWoodland';
          } else {
            cell.waterLandsType = 'reedBed';
          }
        } else {
          // Higher ground within the wetlands: raised island
          cell.waterLandsType = 'raisedIsland';
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fine-scale river generation for high-res patches
// ---------------------------------------------------------------------------

/**
 * Generates rivers at fine (patch) resolution.
 *
 * The coarse map is 300×500 cells; each coarse cell covers roughly 1 square
 * mile. A patch subdivides each coarse cell into resScale×resScale fine cells.
 * Naïvely re-running the watershed on the patch would miss all drainage that
 * originates outside the patch boundary, so large rivers would lose their
 * upstream contribution and disappear.
 *
 * Fix: normalise each fine cell's rainfall to coarse-equivalent units
 * (divide by resScale²) so the threshold of 80 keeps the same geographic
 * meaning. Then, for every coarse river cell that has no upstream river
 * neighbour already inside the patch — river heads and patch-entry cells —
 * inject the full coarse riverFlow into the highest-altitude fine cell of
 * that coarse cell. This seeds the accumulated upstream drainage that the
 * fine watershed cannot see (drainage outside the patch, or non-river
 * feeder cells whose individual flows are all below the coarse threshold).
 *
 * Result: rivers are 1 fine cell wide (not resScale cells wide), follow
 * fine-resolution terrain, and correctly represent the coarse river network.
 */
function generateRiversForPatch(
  cells: TerrainCell[][],
  width: number,
  height: number,
  coarseMap: TerrainMap,
  coarseX0: number,
  coarseY0: number,
  patchCoarseW: number,
  patchCoarseH: number,
  resScale: number
): void {
  const flow = Array.from({ length: height }, () => new Float32Array(width));

  // Normalised rainfall: resScale² fine cells = 1 coarse cell, so dividing
  // by resScale² keeps accumulated flow in coarse-equivalent units.
  const rainfallScale = 1 / (resScale * resScale);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cells[y][x].geology !== GeologyType.Water) {
        flow[y][x] = (0.5 + cells[y][x].altitude * 0.5) * rainfallScale;
      }
    }
  }

  // Upstream injection: for each coarse river cell in the patch that has an
  // upstream river neighbour outside the patch, inject the coarse riverFlow
  // into the highest-altitude fine cell inside that coarse cell. This
  // simulates drainage that exists on the wider map but has no fine cells
  // here to accumulate it.
  const dirs8: [number, number][] = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1],
  ];

  for (let cy = coarseY0; cy < coarseY0 + patchCoarseH; cy++) {
    for (let cx = coarseX0; cx < coarseX0 + patchCoarseW; cx++) {
      const coarseCell = coarseMap.cells[cy][cx];
      if (coarseCell.riverFlow <= 0) continue;

      // Inject unless there is an upstream river neighbour (higher altitude,
      // also a river) already inside the patch — in which case the fine
      // watershed will receive that upstream flow naturally and no seeding
      // is needed here.
      //
      // This covers two cases that both require injection:
      //   • River heads (no upstream river anywhere): drainage basin may
      //     extend beyond the patch via non-river cells; fine rainfall alone
      //     underestimates the flow.
      //   • Entry points (upstream river is outside the patch): the fine
      //     watershed has no fine cells for that upstream reach at all.
      let hasUpstreamInsidePatch = false;
      for (const [dx, dy] of dirs8) {
        const ncx = cx + dx, ncy = cy + dy;
        if (ncx < 0 || ncx >= coarseMap.width || ncy < 0 || ncy >= coarseMap.height) continue;
        const nb = coarseMap.cells[ncy][ncx];
        if (nb.altitude <= coarseCell.altitude || nb.riverFlow <= 0) continue;
        if (
          ncx >= coarseX0 && ncx < coarseX0 + patchCoarseW &&
          ncy >= coarseY0 && ncy < coarseY0 + patchCoarseH
        ) {
          hasUpstreamInsidePatch = true;
          break;
        }
      }
      if (hasUpstreamInsidePatch) continue;

      // Inject at the highest-altitude fine cell within this coarse cell
      // (the "upstream end" at fine resolution).
      const fxBase = (cx - coarseX0) * resScale;
      const fyBase = (cy - coarseY0) * resScale;
      let bestAlt = -1, bestFx = -1, bestFy = -1;
      for (let dy = 0; dy < resScale; dy++) {
        for (let dx = 0; dx < resScale; dx++) {
          const fx = fxBase + dx, fy = fyBase + dy;
          if (fx < 0 || fx >= width || fy < 0 || fy >= height) continue;
          if (cells[fy][fx].altitude > bestAlt) {
            bestAlt = cells[fy][fx].altitude;
            bestFx = fx; bestFy = fy;
          }
        }
      }
      if (bestFx >= 0) flow[bestFy][bestFx] += coarseCell.riverFlow;
    }
  }

  // Sort fine cells by altitude (highest first) and cascade flow downhill.
  const sorted: [number, number][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) sorted.push([x, y]);
  }
  sorted.sort((a, b) => cells[b[1]][b[0]].altitude - cells[a[1]][a[0]].altitude);

  const dirs: [number, number][] = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1],
  ];
  for (const [x, y] of sorted) {
    if (cells[y][x].geology === GeologyType.Water) continue;
    let lowestAlt = cells[y][x].altitude, lx = -1, ly = -1;
    for (const [dx, dy] of dirs) {
      const nx2 = x + dx, ny2 = y + dy;
      if (nx2 >= 0 && nx2 < width && ny2 >= 0 && ny2 < height &&
          cells[ny2][nx2].altitude < lowestAlt) {
        lowestAlt = cells[ny2][nx2].altitude;
        lx = nx2; ly = ny2;
      }
    }
    if (lx >= 0) flow[ly][lx] += flow[y][x];
  }

  // Same threshold as the coarse map — flow is in coarse-equivalent units.
  const riverThreshold = 80;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (flow[y][x] > riverThreshold && cells[y][x].geology !== GeologyType.Water) {
        cells[y][x].riverFlow = flow[y][x];
      }
    }
  }

  // River widening: major rivers should be several cells wide at fine resolution.
  // For each river cell, spread flow into nearby cells proportional to flow volume.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const riverFlow = cells[y][x].riverFlow;
      if (riverFlow <= 0) continue;
      const extraWidth = Math.floor(Math.min(3, riverFlow / 200));
      if (extraWidth <= 0) continue;
      for (let dy = -extraWidth; dy <= extraWidth; dy++) {
        for (let dx = -extraWidth; dx <= extraWidth; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx2 = x + dx, ny2 = y + dy;
          if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
          if (cells[ny2][nx2].geology === GeologyType.Water) continue;
          if (cells[ny2][nx2].riverFlow < riverThreshold) {
            cells[ny2][nx2].riverFlow = riverThreshold;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// High-resolution patch generation
// ---------------------------------------------------------------------------

/**
 * Generates a fine-resolution TerrainMap covering a rectangular sub-region
 * of the coarse map. Each coarse cell is subdivided into resScale×resScale
 * fine cells. Uses the same noise and generation logic as the coarse map,
 * with an additional high-frequency detail layer. Deterministic: the same
 * coarse position and resScale always produce the same patch.
 */
export function generateHighResPatch(
  coarseMap: TerrainMap,
  noise: NoiseGenerator,
  coarseX0: number,
  coarseY0: number,
  patchCoarseW: number,
  patchCoarseH: number,
  resScale: number
): TerrainMap {
  const { noise2D } = noise;
  const fineW = patchCoarseW * resScale;
  const fineH = patchCoarseH * resScale;
  const cells: TerrainCell[][] = [];

  for (let fy = 0; fy < fineH; fy++) {
    const row: TerrainCell[] = [];
    for (let fx = 0; fx < fineW; fx++) {
      // Fractional coarse coordinates — same nx/ny space as the coarse map
      const coarseX = coarseX0 + fx / resScale;
      const coarseY = coarseY0 + fy / resScale;
      const nx = coarseX / coarseMap.width;
      const ny = 1 - coarseY / coarseMap.height;

      // Base altitude (identical to coarse at coarse-cell centres, smoothly
      // interpolated between them via fractional gx/gy)
      let altitude = generateAltitude(noise, nx, ny, coarseX, coarseY);

      // High-frequency detail: adds sub-coarse-cell variation that averages
      // to zero at the coarse scale. Offset 80000 keeps it uncorrelated with
      // all base noise domains.
      altitude += layeredNoise(
        noise2D,
        coarseX * resScale + 80000,
        coarseY * resScale + 80000,
        3, 0.5, 2.0, 0.12
      ) * 0.025;
      altitude = Math.max(0, Math.min(1, altitude));

      const geology = classifyGeology(nx, ny, altitude, noise, coarseX, coarseY);

      row.push({ altitude, geology, riverFlow: 0, isCoast: false, nx, ny });
    }
    cells.push(row);
  }

  generateRiversForPatch(
    cells, fineW, fineH,
    coarseMap, coarseX0, coarseY0, patchCoarseW, patchCoarseH, resScale
  );

  markCoasts(cells, fineW, fineH);
  fixCoastalGeology(cells, fineW, fineH, noise, coarseMap.width, coarseMap.height);
  classifyWaterLands(cells, fineW, fineH, noise, coarseMap.width, coarseMap.height);

  return { width: fineW, height: fineH, cells, seed: coarseMap.seed };
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
  fixCoastalGeology(cells, width, height, noise, width, height);
  classifyWaterLands(cells, width, height, noise, width, height);

  return { width, height, cells, seed };
}
