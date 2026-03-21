/**
 * Habitation generation for The Barrow.
 *
 * This module is built incrementally. Step 1: Animal Distribution Overlay.
 * Each subsequent step adds to this file or calls into it.
 */

import { TerrainMap } from "./terrain";
import { GeologyType } from "./geology";
import { createSeededNoise } from "./noise";

// ---------------------------------------------------------------------------
// Step 1: Animal Distribution Overlay
// ---------------------------------------------------------------------------

export interface FoodResources {
  deer:      number;  // 0-1 density
  boar:      number;  // 0-1 density
  aurochs:   number;  // 0-1 density
  fish:      number;  // 0-1 availability
  wildfowl:  number;  // 0-1 density
  hares:     number;  // 0-1 density
  shellfish: number;  // 0-1 availability
  wolfRisk:  number;  // 0-1 danger level
  bearRisk:  number;  // 0-1 danger level
}

export interface PredatorTerritory {
  cx: number;     // grid x
  cy: number;     // grid y
  radius: number;
}

export interface FoodResourceMap {
  width:            number;
  height:           number;
  /** Flat array indexed [y * width + x]. */
  grid:             FoodResources[];
  wolfTerritories:  PredatorTerritory[];
  bearRanges:       PredatorTerritory[];
}

// ---------------------------------------------------------------------------
// Multi-source BFS proximity map
// ---------------------------------------------------------------------------

/**
 * Returns a flat Int16Array where each entry is the BFS distance (in cells)
 * from the nearest source cell, capped at `maxDist`. Unreachable cells get
 * maxDist + 1.
 */
function bfsProximity(
  width: number,
  height: number,
  maxDist: number,
  isSource: (idx: number) => boolean
): Int16Array {
  const INF = maxDist + 1;
  const dist = new Int16Array(width * height).fill(INF);
  const queue: number[] = [];

  for (let i = 0; i < width * height; i++) {
    if (isSource(i)) {
      dist[i] = 0;
      queue.push(i);
    }
  }

  const dirs = [-width, width, -1, 1]; // N S W E (4-connected)

  for (let qi = 0; qi < queue.length; qi++) {
    const idx = queue[qi];
    const d = dist[idx];
    if (d >= maxDist) continue;
    const cx = idx % width;
    const cy = (idx - cx) / width;

    for (const dd of dirs) {
      const ni = idx + dd;
      if (ni < 0 || ni >= width * height) continue;
      // Prevent wrap-around at east/west edges
      const nx2 = ni % width;
      if (Math.abs(nx2 - cx) > 1) continue;
      if (dist[ni] > d + 1) {
        dist[ni] = d + 1;
        queue.push(ni);
      }
    }
  }

  return dist;
}

// ---------------------------------------------------------------------------
// Per-cell food resource computation
// ---------------------------------------------------------------------------

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Computes base deer density for a cell's geology, before modifiers.
 */
function deerBase(geo: GeologyType): number {
  switch (geo) {
    case GeologyType.Clay:      return 0.55;
    case GeologyType.Chalk:     return 0.60;
    case GeologyType.Limestone: return 0.75;
    case GeologyType.Sandstone: return 0.40;
    case GeologyType.Slate:     return 0.60;
    case GeologyType.Granite:   return 0.35;
    case GeologyType.Glacial:   return 0.15;
    default: return 0;
  }
}

function boarBase(geo: GeologyType): number {
  switch (geo) {
    case GeologyType.Clay:      return 0.70;
    case GeologyType.Limestone: return 0.65;
    case GeologyType.Slate:     return 0.60;
    case GeologyType.Sandstone: return 0.25;
    case GeologyType.Chalk:     return 0.20;
    case GeologyType.Granite:   return 0.10;
    case GeologyType.Glacial:   return 0.05;
    default: return 0;
  }
}

function aurochsBase(geo: GeologyType): number {
  switch (geo) {
    case GeologyType.Chalk:     return 0.60;
    case GeologyType.Limestone: return 0.45;
    case GeologyType.Clay:      return 0.35;
    case GeologyType.Sandstone: return 0.20;
    case GeologyType.Granite:   return 0.05;
    default: return 0;
  }
}

function haresBase(geo: GeologyType): number {
  switch (geo) {
    case GeologyType.Chalk:     return 0.70;
    case GeologyType.Sandstone: return 0.55;
    case GeologyType.Granite:   return 0.45;
    case GeologyType.Limestone: return 0.50;
    case GeologyType.Clay:      return 0.20;
    case GeologyType.Glacial:   return 0.30;
    default: return 0;
  }
}

// ---------------------------------------------------------------------------
// Wolf / bear territory placement helpers
// ---------------------------------------------------------------------------

function minSpacingFilter(
  candidates: { x: number; y: number; score: number }[],
  minSpacing: number
): { x: number; y: number; score: number }[] {
  const chosen: { x: number; y: number; score: number }[] = [];
  for (const c of candidates) {
    const tooClose = chosen.some(
      (p) => Math.hypot(p.x - c.x, p.y - c.y) < minSpacing
    );
    if (!tooClose) chosen.push(c);
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function computeFoodResources(
  terrain: TerrainMap,
  seed: string
): FoodResourceMap {
  const { width, height, cells } = terrain;
  const seaLevel = 0.22;

  // Seeded RNG for predator placement
  const rng = createSeededNoise(seed + "\0food").random;

  // ── Proximity maps ────────────────────────────────────────────────────────
  const nearRiver = bfsProximity(width, height, 10,
    (i) => {
      const x = i % width, y = (i - x) / width;
      return cells[y][x].riverFlow > 0;
    }
  );

  const nearCoast = bfsProximity(width, height, 10,
    (i) => {
      const x = i % width, y = (i - x) / width;
      return cells[y][x].isCoast;
    }
  );

  const nearWaterLands = bfsProximity(width, height, 8,
    (i) => {
      const x = i % width, y = (i - x) / width;
      return cells[y][x].waterLandsType !== undefined;
    }
  );

  // ── Per-cell base food values (before predator risk) ─────────────────────
  const baseGrid: Omit<FoodResources, 'wolfRisk' | 'bearRisk'>[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y][x];
      const { geology: geo, altitude: alt, riverFlow, isCoast, waterLandsType } = cell;
      const idx = y * width + x;
      const rDist = nearRiver[idx];
      const cDist = nearCoast[idx];
      const wDist = nearWaterLands[idx];
      const inWaterLands = waterLandsType !== undefined;

      // ── Deer ──────────────────────────────────────────────────────────────
      let deer = deerBase(geo);
      if (deer > 0) {
        if (alt > 0.45) deer += 0.15; // summer upland shift
        if (rDist <= 3) deer += 0.10; // forest-edge / river meadow bonus
      }
      deer = clamp(deer);

      // ── Boar ──────────────────────────────────────────────────────────────
      let boar = boarBase(geo);
      if (boar > 0) {
        if (alt > 0.40) boar *= 0.30;
        if (rDist <= 2) boar = clamp(boar + 0.10);
      }
      boar = clamp(boar);

      // ── Aurochs ───────────────────────────────────────────────────────────
      let aurochs = aurochsBase(geo);
      if (alt > 0.38) aurochs *= 0.40;
      aurochs = clamp(aurochs);

      // ── Fish ──────────────────────────────────────────────────────────────
      let fish = 0;
      if (inWaterLands) {
        fish = 0.70;
      } else if (riverFlow > 0) {
        fish = Math.min(1, riverFlow / 400);
        // Confluence bonus: check if 2+ orthogonal neighbours also have river flow
        let riverNeighbours = 0;
        if (x > 0 && cells[y][x - 1].riverFlow > 80) riverNeighbours++;
        if (x < width - 1 && cells[y][x + 1].riverFlow > 80) riverNeighbours++;
        if (y > 0 && cells[y - 1][x].riverFlow > 80) riverNeighbours++;
        if (y < height - 1 && cells[y + 1][x].riverFlow > 80) riverNeighbours++;
        if (riverNeighbours >= 2) fish = clamp(fish + 0.25);
        // Tidal reach
        if (isCoast) fish = clamp(fish + 0.30);
      } else if (rDist <= 1 && !inWaterLands) {
        // Bank cell right next to a river
        const rCell = (() => {
          const ns = [[y, x-1],[y, x+1],[y-1, x],[y+1, x]];
          for (const [ry, rx] of ns) {
            if (ry >= 0 && ry < height && rx >= 0 && rx < width && cells[ry][rx].riverFlow > 0) {
              return cells[ry][rx];
            }
          }
          return null;
        })();
        fish = rCell ? Math.min(0.50, rCell.riverFlow / 400) : 0;
        if (isCoast) fish = clamp(fish + 0.30);
      } else if (isCoast && !inWaterLands) {
        fish = 0.45; // sea fishing
      }
      fish = clamp(fish);

      // ── Wildfowl ──────────────────────────────────────────────────────────
      let wildfowl = 0;
      if (inWaterLands) {
        wildfowl = 0.85;
      } else if (isCoast) {
        wildfowl = 0.50;
      } else if (wDist <= 3) {
        wildfowl = 0.60 * Math.max(0, 1 - wDist / 4);
      } else if (rDist <= 2) {
        wildfowl = 0.35;
      }
      wildfowl = clamp(wildfowl);

      // ── Hares ─────────────────────────────────────────────────────────────
      let hares = haresBase(geo);
      if (alt > 0.45 && hares > 0) hares = clamp(hares + 0.10);
      hares = clamp(hares);

      // ── Shellfish ─────────────────────────────────────────────────────────
      let shellfish = 0;
      if (inWaterLands &&
          (waterLandsType === 'mudFlat' || waterLandsType === 'openWater' || waterLandsType === 'reedBed')) {
        shellfish = 0.70;
      } else if (isCoast) {
        shellfish = 0.50;
      } else if (cDist <= 2) {
        shellfish = 0.40 * Math.max(0, 1 - cDist / 3);
      }
      shellfish = clamp(shellfish);

      baseGrid.push({ deer, boar, aurochs, fish, wildfowl, hares, shellfish });
    }
  }

  // ── Wolf territory placement ───────────────────────────────────────────────
  // Candidates: high deer density in less-settled terrain (away from coasts,
  // in granite/slate/clay far from the sea)
  const wolfCandidates: { x: number; y: number; score: number }[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const cell = cells[y][x];
      const geo = cell.geology;
      const r = baseGrid[idx];
      // Low-pressure zones: not coastal, not water-lands, deeper inland
      if (cell.isCoast || cell.waterLandsType) continue;
      if (geo === GeologyType.Water || geo === GeologyType.Ice) continue;
      const cDist2 = nearCoast[idx];
      if (cDist2 < 5) continue; // too close to coast = more people
      if (r.deer > 0.40) {
        // Score: deer density, penalise if too close to coasts
        const score = r.deer + (cDist2 > 10 ? 0.10 : 0);
        wolfCandidates.push({ x, y, score });
      }
    }
  }
  wolfCandidates.sort((a, b) => b.score - a.score);

  const wolfCount = 8 + Math.floor(rng() * 5); // 8-12
  const wolfChosen = minSpacingFilter(wolfCandidates.slice(0, 60), 15).slice(0, wolfCount);
  const wolfTerritories: PredatorTerritory[] = wolfChosen.map((c) => ({
    cx: c.x, cy: c.y,
    radius: 8 + Math.floor(rng() * 5), // 8-12
  }));

  // ── Bear range placement ───────────────────────────────────────────────────
  // Candidates: forested cells (Clay below treeline, Limestone valleys, Slate)
  const bearCandidates: { x: number; y: number; score: number }[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y][x];
      const geo = cell.geology;
      const alt = cell.altitude;
      if (geo === GeologyType.Water || geo === GeologyType.Ice) continue;
      if (cell.waterLandsType) continue;
      const isForested =
        (geo === GeologyType.Clay && alt < 0.40) ||
        (geo === GeologyType.Limestone && alt < 0.36) ||
        (geo === GeologyType.Slate);
      if (!isForested) continue;
      const idx = y * width + x;
      const cDist2 = nearCoast[idx];
      if (cDist2 < 3) continue;
      const score = (geo === GeologyType.Clay ? 0.8 : geo === GeologyType.Slate ? 0.7 : 0.6)
        + (cDist2 > 8 ? 0.1 : 0);
      bearCandidates.push({ x, y, score });
    }
  }
  bearCandidates.sort((a, b) => b.score - a.score);

  const bearCount = 20 + Math.floor(rng() * 21); // 20-40
  const bearChosen = minSpacingFilter(bearCandidates.slice(0, 200), 6).slice(0, bearCount);
  const bearRanges: PredatorTerritory[] = bearChosen.map((c) => ({
    cx: c.x, cy: c.y,
    radius: 4 + Math.floor(rng() * 3), // 4-6
  }));

  // ── Apply predator risk to grid ────────────────────────────────────────────
  const grid: FoodResources[] = baseGrid.map((base, idx) => ({
    ...base,
    wolfRisk: 0,
    bearRisk: 0,
  }));

  for (const t of wolfTerritories) {
    const r2 = t.radius;
    const x0 = Math.max(0, t.cx - r2 - 1);
    const x1 = Math.min(width - 1, t.cx + r2 + 1);
    const y0 = Math.max(0, t.cy - r2 - 1);
    const y1 = Math.min(height - 1, t.cy + r2 + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.hypot(x - t.cx, y - t.cy);
        const risk = Math.max(0, 1 - dist / r2);
        const idx = y * width + x;
        if (risk > grid[idx].wolfRisk) grid[idx].wolfRisk = risk;
      }
    }
  }

  for (const b of bearRanges) {
    const r2 = b.radius;
    const x0 = Math.max(0, b.cx - r2 - 1);
    const x1 = Math.min(width - 1, b.cx + r2 + 1);
    const y0 = Math.max(0, b.cy - r2 - 1);
    const y1 = Math.min(height - 1, b.cy + r2 + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.hypot(x - b.cx, y - b.cy);
        const risk = Math.max(0, 1 - dist / r2) * 0.80;
        const idx = y * width + x;
        if (risk > grid[idx].bearRisk) grid[idx].bearRisk = risk;
      }
    }
  }

  return { width, height, grid, wolfTerritories, bearRanges };
}

// ---------------------------------------------------------------------------
// Step 2: Wight Territories
// ---------------------------------------------------------------------------

export interface CaveWightTerritory {
  cx: number;
  cy: number;
  /** Core radius — almost nobody lives here. */
  coreRadius: number;
  /** Peripheral radius — settlement is suppressed but not zero. */
  peripheralRadius: number;
  occupied: boolean;
}

export interface SmallFolkTerritory {
  cx: number;
  cy: number;
  radius: number;
  occupied: boolean;
}

export interface WightData {
  caveWights:  CaveWightTerritory[];
  smallFolk:   SmallFolkTerritory[];
}

/**
 * Generates wight territories from terrain data.
 *
 * Cave-wights: limestone at moderate altitude (0.28–0.50) with high local
 * terrain complexity (roughness suggesting cave-forming landscape).
 * 10–15 candidate sites; 8–12 are occupied.
 *
 * Small-folk: warm wet habitat — low-altitude clay or water-lands with
 * high moisture (near rivers, in water-lands, near coast).
 * 5–10 candidate sites; 3–7 are occupied.
 *
 * Territories are invisible data only — not rendered, but influence
 * carrying capacity (Step 3) and sacred site placement (Step 7).
 */
export function generateWightTerritories(
  terrain: TerrainMap,
  seed: string
): WightData {
  const { width, height, cells } = terrain;
  const rng = createSeededNoise(seed + "\0wight").random;

  // ── Terrain roughness (local altitude standard deviation) ─────────────────
  // Used to identify cave-forming limestone terrain. Computed over a radius-3
  // window; stored as a flat Float32Array.
  const ROUGH_RADIUS = 3;
  const roughness = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, sumSq = 0, count = 0;
      for (let dy = -ROUGH_RADIUS; dy <= ROUGH_RADIUS; dy++) {
        for (let dx = -ROUGH_RADIUS; dx <= ROUGH_RADIUS; dx++) {
          const nx2 = x + dx, ny2 = y + dy;
          if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
          const a = cells[ny2][nx2].altitude;
          sum += a;
          sumSq += a * a;
          count++;
        }
      }
      const mean = sum / count;
      roughness[y * width + x] = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
    }
  }

  // ── Proximity maps needed for small-folk ─────────────────────────────────
  const nearRiver = bfsProximity(width, height, 6,
    (i) => { const x = i % width, y = (i - x) / width; return cells[y][x].riverFlow > 0; }
  );
  const nearCoast = bfsProximity(width, height, 6,
    (i) => { const x = i % width, y = (i - x) / width; return cells[y][x].isCoast; }
  );

  // ── Cave-wight candidates ─────────────────────────────────────────────────
  type Candidate = { x: number; y: number; score: number };
  const caveRaw: Candidate[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y][x];
      if (cell.geology !== GeologyType.Limestone) continue;
      if (cell.altitude < 0.28 || cell.altitude > 0.50) continue;
      const rough = roughness[y * width + x];
      if (rough < 0.018) continue; // not complex enough
      const score = rough * 10 + (cell.altitude - 0.28) / 0.22;
      caveRaw.push({ x, y, score });
    }
  }
  caveRaw.sort((a, b) => b.score - a.score);

  // Apply minimum spacing to get distinct territories (min 12 cells apart)
  const caveSpaced = minSpacingFilter(caveRaw, 12);
  // Take 10-15 candidates (but no more than available)
  const caveCandidateCount = Math.min(caveSpaced.length, 10 + Math.floor(rng() * 6));
  const caveCandidates = caveSpaced.slice(0, caveCandidateCount);

  // Mark 8-12 as occupied (at least 80% of candidates, but cap at available)
  const caveOccupiedCount = Math.min(caveCandidates.length, 8 + Math.floor(rng() * 5));
  // Shuffle candidates lightly with RNG so occupied ones aren't always the top-scorers
  const caveShuffled = [...caveCandidates].sort(() => rng() - 0.5);

  const caveWights: CaveWightTerritory[] = caveShuffled.map((c, i) => ({
    cx: c.x,
    cy: c.y,
    coreRadius:       3 + Math.floor(rng() * 2),  // 3-4
    peripheralRadius: 6 + Math.floor(rng() * 3),  // 6-8
    occupied: i < caveOccupiedCount,
  }));

  // ── Small-folk candidates ─────────────────────────────────────────────────
  const sfRaw: Candidate[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y][x];
      // Warm wet habitat: low clay or water-lands
      const isLowClay = cell.geology === GeologyType.Clay
        && cell.altitude < 0.30
        && cell.altitude >= 0.22;
      const isWaterLands = cell.waterLandsType !== undefined
        && (cell.waterLandsType === 'raisedIsland' || cell.waterLandsType === 'carrWoodland');
      if (!isLowClay && !isWaterLands) continue;

      const idx = y * width + x;
      const rDist = nearRiver[idx];
      const cDist = nearCoast[idx];
      // Need moisture: near river, in water-lands, or near coast
      if (rDist > 3 && cDist > 4 && !isWaterLands) continue;

      let score = 0;
      if (isWaterLands) score += 0.5;
      if (rDist <= 1) score += 0.4;
      else if (rDist <= 3) score += 0.2;
      if (cDist <= 2) score += 0.2;
      sfRaw.push({ x, y, score });
    }
  }
  sfRaw.sort((a, b) => b.score - a.score);

  // Spacing 10 cells apart so territories are geographically distinct
  const sfSpaced = minSpacingFilter(sfRaw, 10);
  const sfCandidateCount = Math.min(sfSpaced.length, 5 + Math.floor(rng() * 6));
  const sfCandidates = sfSpaced.slice(0, sfCandidateCount);

  const sfOccupiedCount = Math.min(sfCandidates.length, 3 + Math.floor(rng() * 5));
  const sfShuffled = [...sfCandidates].sort(() => rng() - 0.5);

  const smallFolk: SmallFolkTerritory[] = sfShuffled.map((c, i) => ({
    cx: c.x,
    cy: c.y,
    radius: 3 + Math.floor(rng() * 3),  // 3-5
    occupied: i < sfOccupiedCount,
  }));

  return { caveWights, smallFolk };
}
