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
