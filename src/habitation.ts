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
  /** BFS distance to nearest river cell, capped at 10. */
  nearRiver:        Int16Array;
  /** BFS distance to nearest coast cell, capped at 10. */
  nearCoast:        Int16Array;
  /** BFS distance to nearest water-lands cell, capped at 8. */
  nearWaterLands:   Int16Array;
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

  return { width, height, grid, wolfTerritories, bearRanges, nearRiver, nearCoast, nearWaterLands };
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

// ---------------------------------------------------------------------------
// Step 3: Carrying Capacity
// ---------------------------------------------------------------------------

export interface CarryingCapacity {
  width:       number;
  height:      number;
  /** Habitability score per cell, flat [y * width + x], values 0..1. */
  habitability: Float32Array;
}

/**
 * Computes a habitability score (0..1) for every coarse cell.
 *
 * Factors (applied in order):
 *   1. Base geology productivity
 *   2. Altitude modifier (full below treeline, ×0.3 above, ×0.1 well above)
 *   3. Water access (×1.3 near river, ×1.2 near coast, ×0.6 if far from all water)
 *   4. Animal bonus (up to +0.15 from food resource density)
 *   5. Cave-wight suppression (×0.1 in core, ×0.5 in peripheral)
 *   6. Water-lands override (raised/carr ground uses fishing/fowling base 0.3;
 *      submerged/reed/mud cells are uninhabitable and score 0)
 */
export function computeCarryingCapacity(
  terrain:   TerrainMap,
  foodMap:   FoodResourceMap,
  wightData: WightData
): CarryingCapacity {
  const { width, height, cells } = terrain;
  const treeline = 0.45;
  const highAlt  = 0.55;

  const { nearRiver, nearCoast, grid: foodGrid } = foodMap;

  // ── Cave-wight suppression grid (1.0 = no suppression) ────────────────────
  const suppression = new Float32Array(width * height).fill(1.0);
  for (const t of wightData.caveWights) {
    if (!t.occupied) continue;
    const maxR = t.peripheralRadius + 1;
    const x0 = Math.max(0, t.cx - maxR);
    const x1 = Math.min(width - 1, t.cx + maxR);
    const y0 = Math.max(0, t.cy - maxR);
    const y1 = Math.min(height - 1, t.cy + maxR);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.hypot(x - t.cx, y - t.cy);
        const factor = dist <= t.coreRadius ? 0.10
          : dist <= t.peripheralRadius      ? 0.50
          : 1.0;
        const idx = y * width + x;
        if (factor < suppression[idx]) suppression[idx] = factor;
      }
    }
  }

  // ── Per-cell habitability ──────────────────────────────────────────────────
  const habitability = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y][x];
      const { geology: geo, altitude: alt, waterLandsType } = cell;
      const idx = y * width + x;

      // Water and ice: not habitable
      if (geo === GeologyType.Water || geo === GeologyType.Ice) continue;

      let h: number;

      // ── Water-lands: different model for raised / submerged ground ─────────
      if (waterLandsType !== undefined) {
        if (waterLandsType === 'raisedIsland' || waterLandsType === 'carrWoodland') {
          // Habitable raised ground within water-lands: fishing/fowling base
          h = 0.30;
        } else {
          // Reed bed, mud flat, open water, tidal channel: not habitable
          continue;
        }
      } else {
        // ── 1. Base geology productivity ───────────────────────────────────
        switch (geo) {
          case GeologyType.Clay:      h = 1.00; break;
          case GeologyType.Chalk:     h = 0.85; break;
          case GeologyType.Limestone: h = 0.65; break;
          case GeologyType.Sandstone: h = 0.45; break;
          case GeologyType.Slate:     h = 0.35; break;
          case GeologyType.Granite:   h = 0.20; break;
          case GeologyType.Glacial:   h = 0.05; break;
          default: h = 0;
        }

        // ── 2. Altitude modifier ───────────────────────────────────────────
        if (alt >= highAlt) {
          h *= 0.10;
        } else if (alt >= treeline) {
          h *= 0.30;
        }
        // below treeline: no modifier (×1.0)
      }

      // ── 3. Water access modifier ───────────────────────────────────────────
      const rDist = nearRiver[idx];
      const cDist = nearCoast[idx];
      if (rDist <= 3) {
        h *= 1.30;
      } else if (cDist <= 3) {
        h *= 1.20;
      } else if (rDist > 8 && cDist > 8) {
        h *= 0.60;
      }

      // ── 4. Animal bonus (up to +0.15) ─────────────────────────────────────
      const food = foodGrid[idx];
      const animalScore = Math.max(food.deer, food.fish, food.boar * 0.7);
      h += animalScore * 0.15;

      // ── 5. Cave-wight suppression ──────────────────────────────────────────
      h *= suppression[idx];

      habitability[idx] = Math.min(1, Math.max(0, h));
    }
  }

  return { width, height, habitability };
}

// ---------------------------------------------------------------------------
// Step 4: Permanent Settlements
// ---------------------------------------------------------------------------

export type SettlementSize = 'homestead' | 'hamlet' | 'village' | 'town';

export interface Settlement {
  x:               number;
  y:               number;
  population:      number;
  size:            SettlementSize;
  isWalledTown:    boolean;
  isWaterLands:    boolean;
  catchmentRadius: number;
}

export interface Ford {
  x: number;
  y: number;
}

export type AbandonedReason = 'waterRose' | 'iceAdvanced' | 'landMarginal';

export interface AbandonedSettlement {
  x:              number;
  y:              number;
  historicalSize: SettlementSize;
  reason:         AbandonedReason;
}

export interface SettlementData {
  settlements: Settlement[];
  fords:       Ford[];
  abandoned:   AbandonedSettlement[];
}

// ---------------------------------------------------------------------------
// Ford identification
// ---------------------------------------------------------------------------

/**
 * Scans for river cells that are shallow and crossable on foot.
 * A ford: riverFlow in (RIVER_THRESHOLD, FORD_MAX_FLOW), and at least one
 * orthogonal non-river neighbour whose altitude is within 0.02 of the
 * river cell (low bank = shallow water).
 */
export function identifyFords(terrain: TerrainMap): Ford[] {
  const { width, height, cells } = terrain;
  const RIVER_MIN  =  80;
  const FORD_MAX   = 300;
  const fords: Ford[] = [];
  const dirs: [number, number][] = [[0,-1],[0,1],[-1,0],[1,0]];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y][x];
      if (cell.riverFlow <= RIVER_MIN || cell.riverFlow >= FORD_MAX) continue;
      for (const [dx, dy] of dirs) {
        const nx2 = x + dx, ny2 = y + dy;
        if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
        const nb = cells[ny2][nx2];
        if (nb.riverFlow > RIVER_MIN) continue; // skip river cells
        if (Math.abs(nb.altitude - cell.altitude) < 0.02) {
          fords.push({ x, y });
          break;
        }
      }
    }
  }
  return fords;
}

// ---------------------------------------------------------------------------
// Settlement placement
// ---------------------------------------------------------------------------

/**
 * Places permanent settlements using greedy catchment-claiming.
 *
 * Phase 1 — mainland: candidates scored by habitability, catchment average,
 * ford/confluence/geology-boundary/coast bonuses. Placed highest-score-first;
 * once a cell is claimed by a catchment no other settlement can use it.
 *
 * Phase 2 — water-lands: raised-ground cells within the water-lands zone,
 * scored by island size, channel proximity, and food density.
 *
 * The first mainland settlement placed (highest score) is the walled town.
 */
export function computeSettlements(
  terrain:   TerrainMap,
  foodMap:   FoodResourceMap,
  carrying:  CarryingCapacity,
  wightData: WightData,
): SettlementData {
  const { width, height, cells } = terrain;
  const { habitability } = carrying;
  const { nearRiver, nearCoast, grid: foodGrid } = foodMap;

  // ── Fords ──────────────────────────────────────────────────────────────────
  const fords = identifyFords(terrain);
  const fordSet = new Set(fords.map(f => f.y * width + f.x));

  // ── Confluences: river cells with 3+ river orthogonal neighbours ───────────
  const confluenceSet = new Set<number>();
  const dirs4: [number,number][] = [[0,-1],[0,1],[-1,0],[1,0]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cells[y][x].riverFlow <= 80) continue;
      let rn = 0;
      for (const [dx, dy] of dirs4) {
        const nx2 = x + dx, ny2 = y + dy;
        if (nx2 >= 0 && nx2 < width && ny2 >= 0 && ny2 < height
            && cells[ny2][nx2].riverFlow > 80) rn++;
      }
      if (rn >= 3) confluenceSet.add(y * width + x);
    }
  }

  // ── BFS proximity maps ─────────────────────────────────────────────────────
  const nearFord = bfsProximity(width, height, 5,
    i => fordSet.has(i));

  const nearConfluence = bfsProximity(width, height, 4,
    i => confluenceSet.has(i));

  // Spring-line: chalk-clay geological boundary
  const nearSpringLine = bfsProximity(width, height, 5, i => {
    const x = i % width, y = (i - x) / width;
    const geo = cells[y][x].geology;
    if (geo !== GeologyType.Chalk && geo !== GeologyType.Clay) return false;
    for (const [dx, dy] of dirs4) {
      const nx2 = x + dx, ny2 = y + dy;
      if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
      const nb = cells[ny2][nx2].geology;
      if ((geo === GeologyType.Chalk && nb === GeologyType.Clay) ||
          (geo === GeologyType.Clay  && nb === GeologyType.Chalk)) return true;
    }
    return false;
  });

  // Any geological boundary (for the +0.1 scoring bonus)
  const nearGeoBoundary = bfsProximity(width, height, 3, i => {
    const x = i % width, y = (i - x) / width;
    const geo = cells[y][x].geology;
    if (geo === GeologyType.Water || geo === GeologyType.Ice) return false;
    for (const [dx, dy] of dirs4) {
      const nx2 = x + dx, ny2 = y + dy;
      if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
      const nb = cells[ny2][nx2].geology;
      if (nb !== geo && nb !== GeologyType.Water && nb !== GeologyType.Ice) return true;
    }
    return false;
  });

  // ── Cave-wight core exclusion ──────────────────────────────────────────────
  const inWightCore = new Uint8Array(width * height);
  for (const t of wightData.caveWights) {
    if (!t.occupied) continue;
    const r = t.coreRadius;
    for (let y = Math.max(0, t.cy - r); y <= Math.min(height - 1, t.cy + r); y++) {
      for (let x = Math.max(0, t.cx - r); x <= Math.min(width - 1, t.cx + r); x++) {
        if (Math.hypot(x - t.cx, y - t.cy) <= r) inWightCore[y * width + x] = 1;
      }
    }
  }

  // ── Score all mainland candidates ──────────────────────────────────────────
  interface Scored { x: number; y: number; score: number }
  const candidates: Scored[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const cell = cells[y][x];
      const hab  = habitability[idx];

      if (hab <= 0.30) continue;
      if (cell.geology === GeologyType.Water || cell.geology === GeologyType.Ice) continue;
      if (cell.waterLandsType !== undefined) continue; // water-lands handled separately
      if (inWightCore[idx]) continue;

      const rDist  = nearRiver[idx];
      const cDist  = nearCoast[idx];
      const slDist = nearSpringLine[idx];
      // Must be near water access (river, spring-line, or coast)
      if (rDist > 3 && slDist > 3 && cDist > 3) continue;

      // Average habitability within 5-cell radius (hinterland quality)
      let sumH = 0, cnt = 0;
      for (let dy = -5; dy <= 5; dy++) {
        for (let dx = -5; dx <= 5; dx++) {
          if (dx * dx + dy * dy > 25) continue;
          const nx2 = x + dx, ny2 = y + dy;
          if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
          sumH += habitability[ny2 * width + nx2];
          cnt++;
        }
      }
      const hAvg = cnt > 0 ? sumH / cnt : 0;

      let score = hab * 0.30 + hAvg * 0.70;
      if (nearFord[idx]        <= 2) score += 0.30;
      if (nearConfluence[idx]  <= 2) score += 0.20;
      if (nearGeoBoundary[idx] <= 1) score += 0.10;
      if (cDist                <= 3) score += 0.15;

      candidates.push({ x, y, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // ── Greedy placement ───────────────────────────────────────────────────────
  const DENSITY   = 5.0;   // people per unit-habitability per cell
  const MAX_POP   = 250000;
  const MIN_SCORE = 0.25;

  const claimed    = new Uint8Array(width * height);
  const settlements: Settlement[] = [];
  let totalPop     = 0;
  let walledTown   = false;

  for (const c of candidates) {
    if (c.score < MIN_SCORE || totalPop >= MAX_POP) break;
    const idx = c.y * width + c.x;
    if (claimed[idx]) continue;

    // Catchment radius: larger for less productive land
    let sumC = 0, cntC = 0;
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        if (dx * dx + dy * dy > 25) continue;
        const nx2 = c.x + dx, ny2 = c.y + dy;
        if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
        sumC += habitability[ny2 * width + nx2];
        cntC++;
      }
    }
    const avgH  = cntC > 0 ? sumC / cntC : 0;
    const catchR = Math.max(3, Math.round(3 + (1 - avgH) * 4));

    // Population = sum of catchment habitability × density factor
    let popSum = 0;
    for (let dy = -catchR; dy <= catchR; dy++) {
      for (let dx = -catchR; dx <= catchR; dx++) {
        if (dx * dx + dy * dy > catchR * catchR) continue;
        const nx2 = c.x + dx, ny2 = c.y + dy;
        if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
        popSum += habitability[ny2 * width + nx2];
      }
    }
    const pop = Math.round(popSum * DENSITY);
    if (pop < 5) continue;

    // Claim catchment
    for (let dy = -catchR; dy <= catchR; dy++) {
      for (let dx = -catchR; dx <= catchR; dx++) {
        if (dx * dx + dy * dy > catchR * catchR) continue;
        const nx2 = c.x + dx, ny2 = c.y + dy;
        if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
        claimed[ny2 * width + nx2] = 1;
      }
    }

    const size: SettlementSize =
      pop >= 100 ? 'town'
      : pop >= 40 ? 'village'
      : pop >= 15 ? 'hamlet'
      : 'homestead';

    // First placed (highest score) = walled town
    const isWalledTown = !walledTown && size === 'town';
    if (isWalledTown) walledTown = true;

    settlements.push({ x: c.x, y: c.y, population: pop, size, isWalledTown,
      isWaterLands: false, catchmentRadius: catchR });
    totalPop += pop;
  }

  // ── Water-lands settlements ────────────────────────────────────────────────
  // Raised ground (raisedIsland, carrWoodland) within the water-lands.
  // Scored by island size, channel proximity, food density.

  const nearChannel = bfsProximity(width, height, 5, i => {
    const x = i % width, y = (i - x) / width;
    const wlt = cells[y][x].waterLandsType;
    return wlt === 'openWater' || wlt === 'tidalChannel';
  });

  const wlCandidates: Scored[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y][x];
      if (cell.waterLandsType !== 'raisedIsland' && cell.waterLandsType !== 'carrWoodland') continue;

      // Island size: count contiguous raised-ground cells within radius 3
      let islandCells = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (dx * dx + dy * dy > 9) continue;
          const nx2 = x + dx, ny2 = y + dy;
          if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
          const wlt = cells[ny2][nx2].waterLandsType;
          if (wlt === 'raisedIsland' || wlt === 'carrWoodland') islandCells++;
        }
      }
      if (islandCells < 2) continue; // too small to settle

      const idx      = y * width + x;
      const food     = foodGrid[idx];
      const chDist   = nearChannel[idx];
      const chScore  = chDist <= 1 ? 1.0 : chDist <= 3 ? 0.6 : chDist <= 5 ? 0.3 : 0;

      const score = (islandCells / 12) + chScore * 0.35 + food.fish * 0.30 + food.wildfowl * 0.20;
      wlCandidates.push({ x, y, score });
    }
  }
  wlCandidates.sort((a, b) => b.score - a.score);

  for (const c of wlCandidates) {
    // Minimum 5-cell spacing between water-lands settlements
    const tooClose = settlements.some(
      s => s.isWaterLands && Math.hypot(s.x - c.x, s.y - c.y) < 5
    );
    if (tooClose) continue;

    const idx  = c.y * width + c.x;
    const food = foodGrid[idx];
    const pop  = Math.max(10, Math.round((food.fish * 0.5 + food.wildfowl * 0.3 + 0.3) * 25));

    settlements.push({ x: c.x, y: c.y, population: Math.min(pop, 30), size: 'hamlet',
      isWalledTown: false, isWaterLands: true, catchmentRadius: 2 });
    totalPop += pop;

    if (settlements.filter(s => s.isWaterLands).length >= 25) break;
  }

  // ── Step 5: Abandoned Settlements ─────────────────────────────────────────
  //
  // Historical landscape modifications applied to each cell:
  //   • Water-lands with alt in [0.19, 0.22): were exposed clay land when
  //     the water level was 0.03 lower → historical hab 0.36
  //   • Any coast cell (Water, not water-lands) with alt in [0.19, 0.22):
  //     submerged by sea-level rise → historical hab 0.32
  //   • Northern cells (ny > 0.55) currently at hab 0–0.30: climate was
  //     marginally warmer → historical hab ×1.20, reason 'iceAdvanced' if ny > 0.60
  //   • Any other cell with hab 0.20–0.30: generally better past conditions
  //     → historical hab ×1.20
  //
  // A cell becomes an abandoned-settlement candidate if:
  //   histHab > MIN_SCORE (0.30) AND currentHab ≤ MIN_SCORE AND not claimed.

  const SEA_LEVEL     = 0.22;
  const HIST_SEA_DROP = 0.03;
  const HIST_SEA      = SEA_LEVEL - HIST_SEA_DROP; // 0.19

  type HistCandidate = { x: number; y: number; histHab: number; reason: AbandonedReason };
  const histCandidates: HistCandidate[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (claimed[idx]) continue;

      const cell   = cells[y][x];
      const curHab = habitability[idx];
      const { geology: geo, altitude: alt, waterLandsType, ny } = cell;

      let histHab: number;
      let reason:  AbandonedReason;

      if (geo === GeologyType.Water && waterLandsType !== undefined) {
        // Water-lands cell now submerged; was marginal wetland clay historically
        if (alt >= HIST_SEA && alt < SEA_LEVEL) {
          histHab = 0.36;
          reason  = 'waterRose';
        } else {
          continue; // deeper open water — was always water
        }
      } else if (geo === GeologyType.Water && cell.isCoast) {
        // Coastal cell submerged by sea-level rise
        if (alt >= HIST_SEA && alt < SEA_LEVEL) {
          histHab = 0.32;
          reason  = 'waterRose';
        } else {
          continue;
        }
      } else if (ny > 0.55 && curHab < MIN_SCORE && curHab > 0) {
        // Northern marginal land — climate shift pushed it below viability
        histHab = curHab * 1.20;
        reason  = ny > 0.60 ? 'iceAdvanced' : 'landMarginal';
      } else if (curHab >= 0.20 && curHab < MIN_SCORE) {
        // Cells just below the modern habitability threshold
        histHab = curHab * 1.20;
        reason  = 'landMarginal';
      } else {
        continue;
      }

      if (histHab <= MIN_SCORE) continue; // still not viable historically

      histCandidates.push({ x, y, histHab, reason });
    }
  }

  histCandidates.sort((a, b) => b.histHab - a.histHab);

  const abandoned: AbandonedSettlement[] = [];
  const MIN_ABANDONED_SPACING = 8;
  const ABANDONED_TARGET      = 15;

  for (const c of histCandidates) {
    if (abandoned.length >= ABANDONED_TARGET) break;
    const tooClose = abandoned.some(
      a => Math.hypot(a.x - c.x, a.y - c.y) < MIN_ABANDONED_SPACING
    );
    if (tooClose) continue;

    // Estimate historical population from a small nominal catchment
    const nominalR   = 4;
    let histPopSum   = 0;
    for (let dy = -nominalR; dy <= nominalR; dy++) {
      for (let dx = -nominalR; dx <= nominalR; dx++) {
        if (dx * dx + dy * dy > nominalR * nominalR) continue;
        const nx2 = c.x + dx, ny2 = c.y + dy;
        if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
        // Use the greater of current or historical hab for neighbours
        const nIdx    = ny2 * width + nx2;
        const nCurHab = habitability[nIdx];
        histPopSum += Math.max(nCurHab, c.histHab * 0.6); // neighbours less boosted
      }
    }
    const histPop = Math.round(histPopSum * DENSITY);
    const historicalSize: SettlementSize =
      histPop >= 100 ? 'town'
      : histPop >= 40 ? 'village'
      : histPop >= 15 ? 'hamlet'
      : 'homestead';

    abandoned.push({ x: c.x, y: c.y, historicalSize, reason: c.reason });
  }

  return { settlements, fords, abandoned };
}

// ---------------------------------------------------------------------------
// Step 6: Path Network
// ---------------------------------------------------------------------------

export interface PathSegment {
  /** Sequence of [x, y] terrain-grid coordinates from source to destination. */
  cells:   [number, number][];
  /** Combined population of all settlements that route through this path. */
  traffic: number;
  fromIdx: number;  // index into settlements array
  toIdx:   number;
}

export interface PathNetwork {
  paths: PathSegment[];
}

// ── Binary min-heap ──────────────────────────────────────────────────────────

class MinHeap {
  private h: Float64Array;
  private v: Int32Array;
  private n = 0;

  constructor(capacity = 32768) {
    this.h = new Float64Array(capacity);
    this.v = new Int32Array(capacity);
  }
  get size() { return this.n; }
  clear() { this.n = 0; }

  push(priority: number, value: number) {
    let i = this.n++;
    this.h[i] = priority;
    this.v[i] = value;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.h[p] <= this.h[i]) break;
      this._swap(i, p);
      i = p;
    }
  }

  pop(): { priority: number; value: number } {
    const top = { priority: this.h[0], value: this.v[0] };
    this.n--;
    if (this.n > 0) {
      this.h[0] = this.h[this.n];
      this.v[0] = this.v[this.n];
      let i = 0;
      while (true) {
        const l = 2*i+1, r = 2*i+2;
        let s = i;
        if (l < this.n && this.h[l] < this.h[s]) s = l;
        if (r < this.n && this.h[r] < this.h[s]) s = r;
        if (s === i) break;
        this._swap(i, s);
        i = s;
      }
    }
    return top;
  }

  private _swap(a: number, b: number) {
    const th = this.h[a]; this.h[a] = this.h[b]; this.h[b] = th;
    const tv = this.v[a]; this.v[a] = this.v[b]; this.v[b] = tv;
  }
}

// ── A* solver (arrays allocated once, reset via touched list) ────────────────

class AStarSolver {
  private readonly gCost:   Float32Array;
  private readonly prev:    Int32Array;
  private readonly closed:  Uint8Array;
  private readonly w:       number;
  private readonly h:       number;
  private readonly heap:    MinHeap;

  constructor(width: number, height: number) {
    this.w      = width;
    this.h      = height;
    this.gCost  = new Float32Array(width * height).fill(Infinity);
    this.prev   = new Int32Array(width * height).fill(-1);
    this.closed = new Uint8Array(width * height);
    this.heap   = new MinHeap(32768);
  }

  /**
   * Finds the lowest-cost path from (x0,y0) to (x1,y1) using the movement
   * cost model from the spec. Returns null if no path found within maxNodes.
   */
  solve(
    terrain:  TerrainMap,
    fordSet:  Set<number>,
    x0: number, y0: number,
    x1: number, y1: number,
    maxNodes = 8000
  ): [number, number][] | null {
    const { w, h } = this;
    const { cells } = terrain;
    const gTouched: number[] = [];
    const cTouched: number[] = [];

    const start = y0 * w + x0;
    const goal  = y1 * w + x1;
    this.gCost[start] = 0;
    gTouched.push(start);
    this.heap.clear();
    this.heap.push(Math.hypot(x0 - x1, y0 - y1), start);

    // 8-directional movement; index 0,2,5,7 are diagonals
    const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
    const DY = [-1,-1,-1,  0, 0,  1, 1, 1];
    const BASE_COST = [Math.SQRT2,1,Math.SQRT2,1,1,Math.SQRT2,1,Math.SQRT2];

    let expanded = 0;
    let found    = false;

    outer: while (this.heap.size > 0 && expanded < maxNodes) {
      const { priority: f, value: idx } = this.heap.pop();
      if (this.closed[idx]) continue;
      this.closed[idx] = 1;
      cTouched.push(idx);
      expanded++;

      if (idx === goal) { found = true; break outer; }

      const cx = idx % w;
      const cy = (idx - cx) / w;
      const gCurr = this.gCost[idx];
      const fromAlt = cells[cy][cx].altitude;

      for (let d = 0; d < 8; d++) {
        const nx2 = cx + DX[d];
        const ny2 = cy + DY[d];
        if (nx2 < 0 || nx2 >= w || ny2 < 0 || ny2 >= h) continue;

        const nIdx  = ny2 * w + nx2;
        if (this.closed[nIdx]) continue;

        const toCell = cells[ny2][nx2];
        const toGeo  = toCell.geology;

        // Movement cost
        let cost = BASE_COST[d];
        if (toGeo === GeologyType.Ice) {
          cost = 999;
        } else if (toGeo === GeologyType.Water) {
          cost = fordSet.has(nIdx) ? 2.0 : 50.0;
        } else {
          cost *= 1 + Math.abs(toCell.altitude - fromAlt) * 15;
          if (toGeo === GeologyType.Clay) cost *= 1.8;
          else if (toGeo === GeologyType.Limestone || toGeo === GeologyType.Slate) cost *= 1.4;
        }

        const newG = gCurr + cost;
        if (newG >= this.gCost[nIdx]) continue;
        if (this.gCost[nIdx] === Infinity) gTouched.push(nIdx);
        this.gCost[nIdx] = newG;
        this.prev[nIdx]  = idx;
        this.heap.push(newG + Math.hypot(nx2 - x1, ny2 - y1), nIdx);
      }
    }

    // Reconstruct path
    let result: [number, number][] | null = null;
    if (found || this.gCost[goal] < Infinity) {
      const path: [number, number][] = [];
      let cur = goal;
      while (cur !== -1) {
        path.push([cur % w, Math.floor(cur / w)]);
        cur = this.prev[cur];
      }
      result = path.reverse();
    }

    // Reset touched cells
    for (const i of gTouched) { this.gCost[i] = Infinity; this.prev[i] = -1; }
    for (const i of cTouched)   this.closed[i] = 0;

    return result;
  }
}

// ── Main path network function ───────────────────────────────────────────────

/**
 * Builds the path network connecting settlements across four phases:
 *   Phase 1 — local A* connections to nearest 3 neighbours
 *   Phase 2 — river bankside connections (settlements on same river, consecutive by altitude)
 *   Phase 3 — ridgeline connections (settlements near the same E-W ridge)
 *   Phase 4 — ford convergence (opposite-bank settlements routed through fords)
 *
 * Traffic is computed by BFS propagation: each settlement's population
 * is added to every path reachable from it through the network.
 */
export function computePathNetwork(
  terrain:        TerrainMap,
  settlementData: SettlementData,
): PathNetwork {
  const { width, height, cells } = terrain;
  const { settlements, fords }   = settlementData;
  const land = settlements.map((s, i) => ({ s, i })).filter(({ s }) => !s.isWaterLands);

  const fordSet = new Set(fords.map(f => f.y * width + f.x));
  const astar   = new AStarSolver(width, height);

  const paths: PathSegment[] = [];
  /** Tracks pairs already connected so we don't duplicate paths. */
  const connected = new Set<string>();
  const pairKey   = (a: number, b: number) => a < b ? `${a}-${b}` : `${b}-${a}`;

  function addPath(i: number, j: number, maxNodes = 8000) {
    const key = pairKey(i, j);
    if (connected.has(key)) return;
    connected.add(key);
    const si = settlements[i], sj = settlements[j];
    const c = astar.solve(terrain, fordSet, si.x, si.y, sj.x, sj.y, maxNodes);
    if (c) paths.push({ cells: c, traffic: 0, fromIdx: i, toIdx: j });
  }

  // ── Phase 1: local connections (nearest 3 neighbours) ──────────────────────
  const NEAR_K  = 3;
  const NEAR_MAX = 55; // cells; don't connect very distant settlements in Phase 1

  for (const { s, i } of land) {
    const nearest = land
      .map(({ s: t, i: j }) => ({ j, d: Math.hypot(t.x - s.x, t.y - s.y) }))
      .filter(({ j, d }) => j !== i && d <= NEAR_MAX)
      .sort((a, b) => a.d - b.d)
      .slice(0, NEAR_K);
    for (const { j } of nearest) addPath(i, j);
  }

  // ── Phase 2: river bankside paths ──────────────────────────────────────────
  // Flood-fill connected river components, then connect settlements on the
  // same river sorted upstream→downstream (by altitude of nearest river cell).

  const riverComp = new Int32Array(width * height).fill(-1);
  const dirs4: [number,number][] = [[0,-1],[0,1],[-1,0],[1,0]];
  let compId = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cells[y][x].riverFlow <= 0 || riverComp[y * width + x] >= 0) continue;
      const q: number[] = [y * width + x];
      riverComp[y * width + x] = compId;
      for (let qi = 0; qi < q.length; qi++) {
        const cur = q[qi];
        const cx = cur % width, cy = (cur - cx) / width;
        for (const [dx, dy] of dirs4) {
          const nx2 = cx + dx, ny2 = cy + dy;
          if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
          const ni = ny2 * width + nx2;
          if (cells[ny2][nx2].riverFlow <= 0 || riverComp[ni] >= 0) continue;
          riverComp[ni] = compId;
          q.push(ni);
        }
      }
      compId++;
    }
  }

  // For each land settlement, find its nearest river component (within 3 cells)
  const settlRiverComp: (number | null)[] = settlements.map((s) => {
    for (let r = 0; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx2 = s.x + dx, ny2 = s.y + dy;
          if (nx2 < 0 || nx2 >= width || ny2 < 0 || ny2 >= height) continue;
          const c = riverComp[ny2 * width + nx2];
          if (c >= 0) return c;
        }
      }
    }
    return null;
  });

  const riverGroups = new Map<number, number[]>();
  for (const { i } of land) {
    const c = settlRiverComp[i];
    if (c === null) continue;
    if (!riverGroups.has(c)) riverGroups.set(c, []);
    riverGroups.get(c)!.push(i);
  }
  for (const group of riverGroups.values()) {
    if (group.length < 2) continue;
    // Sort upstream (higher altitude) first
    group.sort((a, b) =>
      cells[settlements[b].y][settlements[b].x].altitude -
      cells[settlements[a].y][settlements[a].x].altitude
    );
    // Connect consecutive settlements along the river
    for (let k = 0; k + 1 < group.length; k++) {
      const dist = Math.hypot(
        settlements[group[k]].x - settlements[group[k+1]].x,
        settlements[group[k]].y - settlements[group[k+1]].y
      );
      if (dist > 80) continue; // too far apart to be on the same useful reach
      addPath(group[k], group[k+1], 12000);
    }
  }

  // ── Phase 3: ridgeline paths ────────────────────────────────────────────────
  // Ridgeline cells: local E-W altitude maxima. Settlements near a connected
  // ridgeline corridor are connected consecutively along the ridge (N→S).

  const ridgeMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width - 1; x++) {
      const a = cells[y][x].altitude;
      if (a > cells[y][x-1].altitude && a > cells[y][x+1].altitude && a > 0.28) {
        ridgeMask[y * width + x] = 1;
      }
    }
  }

  const nearRidge = bfsProximity(width, height, 5, i => ridgeMask[i] === 1);

  // Sort ridge-adjacent settlements N→S and connect consecutive within range
  const ridgeLand = land
    .filter(({ s, i }) => !s.isWaterLands && nearRidge[s.y * width + s.x] <= 5)
    .sort((a, b) => b.s.y - a.s.y); // ascending y = N→S (y=0 is south in ny coords, but terrain y=0 is top/north)

  for (let k = 0; k + 1 < ridgeLand.length; k++) {
    const { s, i } = ridgeLand[k];
    const { s: t, i: j } = ridgeLand[k+1];
    const dist = Math.hypot(s.x - t.x, s.y - t.y);
    if (dist > 60) continue;
    addPath(i, j, 10000);
  }

  // ── Phase 4: ford convergence ───────────────────────────────────────────────
  // Settlements within 10 cells of a ford that aren't already connected get
  // a path routed through the ford (A* cost-2 ford cell beats cost-50 water).

  for (const ford of fords) {
    const nearby = land
      .filter(({ s }) => Math.hypot(s.x - ford.x, s.y - ford.y) <= 10)
      .map(({ i }) => i);
    for (let a = 0; a < nearby.length; a++) {
      for (let b = a + 1; b < nearby.length; b++) {
        // Only bother if they're on different sides of the river crossing
        const si = settlements[nearby[a]], sj = settlements[nearby[b]];
        const sameXSide = (si.x - ford.x) * (sj.x - ford.x) >= 0;
        const sameYSide = (si.y - ford.y) * (sj.y - ford.y) >= 0;
        if (sameXSide && sameYSide) continue; // same side — skip
        addPath(nearby[a], nearby[b], 12000);
      }
    }
  }

  // ── Traffic scoring ─────────────────────────────────────────────────────────
  // Build adjacency list on the settlement graph, then BFS from each settlement,
  // adding its population to every path reachable through the network.

  const adjList: { toIdx: number; pathIdx: number }[][] = Array.from(
    { length: settlements.length }, () => []
  );
  for (let pi = 0; pi < paths.length; pi++) {
    const { fromIdx, toIdx } = paths[pi];
    adjList[fromIdx].push({ toIdx, pathIdx: pi });
    adjList[toIdx].push({ toIdx: fromIdx, pathIdx: pi });
  }

  const trafficArr = new Float32Array(paths.length);
  const visitBuf   = new Uint8Array(settlements.length);
  const visitQ:    number[] = [];

  for (let si = 0; si < settlements.length; si++) {
    const pop = settlements[si].population;
    if (pop <= 0) continue;

    // BFS through path graph from si
    visitBuf[si] = 1;
    visitQ.length = 0;
    visitQ.push(si);

    for (let qi = 0; qi < visitQ.length; qi++) {
      const cur = visitQ[qi];
      for (const { toIdx, pathIdx } of adjList[cur]) {
        trafficArr[pathIdx] += pop;
        if (!visitBuf[toIdx]) {
          visitBuf[toIdx] = 1;
          visitQ.push(toIdx);
        }
      }
    }

    // Reset visit buffer
    for (const idx of visitQ) visitBuf[idx] = 0;
  }

  for (let pi = 0; pi < paths.length; pi++) paths[pi].traffic = trafficArr[pi];

  return { paths };
}
