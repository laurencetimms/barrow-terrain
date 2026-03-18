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

// --- Noise-warped boundary helpers ---
// Instead of clean geometric masks, we use noise to distort every boundary.
// This makes geological zones feel organic rather than rectangular.

// Returns a warped version of a normalised coordinate, displaced by noise.
// The result is that boundaries wobble, branch, and have irregular edges.
function warpCoord(
  noise2D: (x: number, y: number) => number,
  x: number,
  y: number,
  offsetX: number,
  offsetY: number,
  scale: number,
  strength: number
): number {
  return layeredNoise(noise2D, x + offsetX, y + offsetY, 4, 0.5, 2.0, scale) * strength;
}

// --- Altitude generation ---
// The fixed frame is expressed through broad tendencies, all noise-warped.

function generateAltitude(
  noise: NoiseGenerator,
  nx: number,
  ny: number,
  gx: number,
  gy: number
): number {
  const { noise2D } = noise;

  // Warp the coordinates themselves so all boundaries become organic
  const warpX = warpCoord(noise2D, gx, gy, 7777, 3333, 0.006, 0.08);
  const warpY = warpCoord(noise2D, gx, gy, 4444, 8888, 0.006, 0.08);
  const wnx = nx + warpX;
  const wny = ny + warpY;

  // --- Mountain spine ---
  // A ridge system in the western portion, with noise-warped centre line
  const spineCentreBase = 0.22;
  // The spine centre wobbles north-south
  const spineWobble = layeredNoise(noise2D, gy * 0.8, 500, 4, 0.5, 2.0, 0.01) * 0.08;
  const spineCentre = spineCentreBase + spineWobble;
  const spineWidth = 0.10 + layeredNoise(noise2D, gy * 0.5, 600, 3, 0.5, 2.0, 0.008) * 0.04;
  const distFromSpine = Math.abs(wnx - spineCentre) / spineWidth;
  let spineHeight = Math.max(0, 1 - distFromSpine * distFromSpine);
  // Spine varies in height along its length
  const spineHeightVar = 0.8 + layeredNoise(noise2D, gy, 700, 3, 0.5, 2.0, 0.012) * 0.3;
  spineHeight *= spineHeightVar;
  // Fade at the northern extreme (ice takes over) and slightly at south
  const spineFadeNorth = Math.min(1, (1 - wny) / 0.2);
  const spineFadeSouth = Math.min(1, wny / 0.12);
  spineHeight *= spineFadeNorth * spineFadeSouth * 0.55;

  // --- Southern uplands (chalk escarpment) ---
  // A rolling ridge system in the south, east-west
  const southRidge = Math.max(0, 1 - wny / 0.28);
  // The escarpment crest — not a straight line but a noise-warped band
  const escarpCentre = 0.14 + layeredNoise(noise2D, gx * 0.7, 800, 3, 0.5, 2.0, 0.01) * 0.04;
  const escarpDist = Math.abs(wny - escarpCentre) / 0.06;
  const escarpBoost = Math.max(0, 1 - escarpDist) * 0.14;
  // Fades in the far west
  const escarpWestFade = Math.min(1, wnx / 0.15);
  const southAlt = (southRidge * 0.15 + escarpBoost) * escarpWestFade;

  // --- Eastern depression ---
  // The east is lower, trending toward the water-lands
  const eastDrop = Math.max(0, (wnx - 0.5) / 0.5);
  // Not uniform — noise makes some eastern areas higher than others
  const eastVar = layeredNoise(noise2D, gx, gy, 3, 0.5, 2.0, 0.012) * 0.06;
  const eastAlt = -(eastDrop * 0.25 + eastDrop * eastVar);

  // --- Water-lands (far east) ---
  // Very low, partially submerged, patchy
  const waterLandsEast = Math.max(0, (wnx - 0.72) / 0.28);
  // Varies with latitude — broader in the middle
  const waterLandsLat = 1 - Math.pow((wny - 0.45) * 2.2, 2) * 0.5;
  const waterLandsAlt = -waterLandsEast * Math.max(0, waterLandsLat) * 0.30;

  // --- Ice margin depression ---
  const iceMargin = Math.max(0, (wny - 0.82) / 0.18);
  const iceAlt = -iceMargin * 0.12;

  // --- Sea margins ---
  // South coast
  const southCoast = Math.max(0, (0.05 - wny) / 0.05);
  // West coast — irregular
  const westCoastLine = 0.06 + layeredNoise(noise2D, gy, 900, 4, 0.5, 2.0, 0.015) * 0.03;
  const westCoast = Math.max(0, (westCoastLine - wnx) / 0.05);
  const seaAlt = -(southCoast + westCoast) * 0.4;

  // --- Base terrain noise ---
  // Large scale features — broad hills and valleys
  const largeNoise = layeredNoise(noise2D, gx, gy, 6, 0.5, 2.0, 0.007) * 0.2;
  // Medium scale — local hills
  const medNoise = layeredNoise(noise2D, gx + 1000, gy + 1000, 4, 0.5, 2.0, 0.022) * 0.08;
  // Small scale — ripple
  const smallNoise = layeredNoise(noise2D, gx + 2000, gy + 2000, 3, 0.5, 2.0, 0.06) * 0.03;

  // --- Combine ---
  let altitude =
    0.33 + // base offset (sets sea level)
    largeNoise +
    medNoise +
    smallNoise +
    spineHeight +
    southAlt +
    eastAlt +
    waterLandsAlt +
    iceAlt +
    seaAlt;

  return Math.max(0, Math.min(1, altitude));
}

// --- Geology classification ---
// Uses noise-warped boundaries throughout so zones have organic, irregular edges.

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

  // Below sea level — water
  if (altitude < seaLevel) {
    return GeologyType.Water;
  }

  // Water-lands — patchy water/land near sea level in the east
  if (altitude < seaLevel + 0.04 && nx > 0.62) {
    const patchNoise = layeredNoise(noise2D, gx + 5000, gy + 5000, 4, 0.5, 2.0, 0.035);
    if (patchNoise < -0.05) return GeologyType.Water;
  }

  // --- Noise-warped zone boundaries ---
  // Each boundary is displaced by noise so zones have irregular edges

  // Glacial boundary — warped north edge
  const glacialEdge = 0.82 + layeredNoise(noise2D, gx + 3100, gy + 3100, 4, 0.5, 2.0, 0.01) * 0.06;
  if (ny > glacialEdge + 0.05) return GeologyType.Glacial;
  if (ny > glacialEdge) {
    // Transition — patches of glacial mixed with whatever's below
    const gMix = layeredNoise(noise2D, gx + 3200, gy + 3200, 3, 0.5, 2.0, 0.025);
    if (gMix > 0.1) return GeologyType.Glacial;
  }

  // --- Western highlands ---
  // The granite/slate zone follows the mountain spine but with warped, irregular edges
  // Use a noise-displaced boundary rather than nx thresholds
  const westBoundary = 0.33 + layeredNoise(noise2D, gy * 0.7 + 4100, gx * 0.3 + 4100, 4, 0.5, 2.0, 0.009) * 0.08;
  const innerWestBoundary = 0.24 + layeredNoise(noise2D, gy * 0.6 + 4200, gx * 0.4 + 4200, 4, 0.5, 2.0, 0.011) * 0.06;

  if (nx < innerWestBoundary && altitude > 0.34) {
    // Inner highlands — granite at higher altitudes
    if (altitude > 0.42) return GeologyType.Granite;
    // Lower inner slopes — slate
    const slateNoise = layeredNoise(noise2D, gx + 2100, gy + 2100, 3, 0.5, 2.0, 0.03);
    return slateNoise > -0.1 ? GeologyType.Slate : GeologyType.Granite;
  }

  if (nx < westBoundary && altitude > 0.38) {
    // Outer highlands — granite peaks, slate and sandstone slopes
    if (altitude > 0.50) return GeologyType.Granite;
    const outerNoise = layeredNoise(noise2D, gx + 2200, gy + 2200, 3, 0.5, 2.0, 0.025);
    if (outerNoise > 0.1) return GeologyType.Slate;
    if (outerNoise < -0.15) return GeologyType.Sandstone;
    return GeologyType.Granite;
  }

  // Far western peninsula — granite even at lower altitudes
  const penBoundary = 0.11 + layeredNoise(noise2D, gy + 4300, gx + 4300, 3, 0.5, 2.0, 0.015) * 0.03;
  if (nx < penBoundary && ny < 0.38 && altitude > seaLevel + 0.02) {
    return GeologyType.Granite;
  }

  // --- Southern chalk ---
  // Chalk zone in the south with noise-warped northern boundary
  const chalkNorthEdge = 0.30 + layeredNoise(noise2D, gx + 4400, gy + 4400, 4, 0.5, 2.0, 0.012) * 0.06;
  const chalkWestEdge = 0.14 + layeredNoise(noise2D, gx + 4500, gy + 4500, 3, 0.5, 2.0, 0.015) * 0.04;

  if (ny < chalkNorthEdge && nx > chalkWestEdge && altitude > seaLevel + 0.02) {
    // Pure chalk at moderate altitude
    if (altitude > 0.28) return GeologyType.Chalk;
    // Lower south — chalk/clay mix with noisy boundary
    const mixNoise = layeredNoise(noise2D, gx + 4600, gy + 4600, 3, 0.5, 2.0, 0.02);
    return mixNoise > 0 ? GeologyType.Chalk : GeologyType.Clay;
  }

  // --- Eastern clay lowlands ---
  const clayWestEdge = 0.48 + layeredNoise(noise2D, gx + 4700, gy + 4700, 4, 0.5, 2.0, 0.01) * 0.08;
  if (nx > clayWestEdge && altitude < 0.34) {
    return GeologyType.Clay;
  }

  // --- Central transitional zone ---
  // The area between the western highlands and the eastern lowlands,
  // and north of the chalk — limestone and sandstone
  const transNoise = layeredNoise(noise2D, gx + 6000, gy + 6000, 4, 0.5, 2.0, 0.013);

  // Higher central ground — limestone dales
  if (altitude > 0.30 && altitude < 0.46) {
    if (transNoise > 0.1) return GeologyType.Limestone;
    if (transNoise < -0.1) return GeologyType.Sandstone;
    return GeologyType.Limestone;
  }

  // Lower central ground — mix
  if (altitude > 0.25 && altitude < 0.35) {
    if (transNoise > 0.15) return GeologyType.Limestone;
    if (transNoise < -0.15) return GeologyType.Sandstone;
    return GeologyType.Clay;
  }

  // Low ground defaults — clay
  if (altitude < 0.30) return GeologyType.Clay;

  // Mid-altitude defaults — sandstone/limestone
  if (altitude < 0.42) {
    const sNoise = layeredNoise(noise2D, gx + 7000, gy + 7000, 3, 0.5, 2.0, 0.018);
    return sNoise > 0 ? GeologyType.Sandstone : GeologyType.Limestone;
  }

  // High ground default — granite
  return GeologyType.Granite;
}

// --- River generation ---

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

// --- Coast marking ---

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

// --- Main generation function ---

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