import { createSeededNoise } from "./noise";
import { generateTerrain, TerrainMap, TerrainCell } from "./terrain";
import { GEOLOGY_INFO } from "./geology";
import {
  computeFoodResources, FoodResourceMap,
  generateWightTerritories, WightData,
  computeCarryingCapacity, CarryingCapacity,
  computeSettlements, SettlementData,
  computePathNetwork, PathNetwork,
  computeSacredSites, SacredData,
  computeSeasonalCamps, SeasonalData,
  computeHuntingCircuits, HuntingData,
  validateHabitation, ValidationReport,
} from "./habitation";
import {
  renderTerrainToBuffer,
  bakeVegetationNoise,
  renderViewport,
  renderHighResViewport,
  renderKeyPanel,
  canvasToTerrain,
  Viewport,
} from "./renderer";

// --- State ---
let currentTerrain: TerrainMap | null = null;
let currentFoodMap: FoodResourceMap | null = null;
let currentWightData: WightData | null = null;
let currentCarrying: CarryingCapacity | null = null;
let currentSettlements: SettlementData | null = null;
let currentPathNetwork: PathNetwork | null = null;
let currentSacred: SacredData | null = null;
let currentSeasonal: SeasonalData | null = null;
let currentHunting: HuntingData | null = null;
let currentValidation: ValidationReport | null = null;
/** Flat-index → max traffic. Built after path network; used for O(1) hover lookups. */
let pathLookup: Map<number, number> | null = null;
let currentBuffer: ImageData | null = null;
let viewport: Viewport = { cx: 150, cy: 250, zoom: 1 };
let showVegetation = false;
let showKey = true;

// --- High-res patch cache (buffer only — terrain lives in the worker) ---
interface HighResCache {
  tier: 2 | 3;
  resScale: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  buffer: ImageData;
}
let highResCache: HighResCache | null = null;

// --- Patch worker ---
const patchWorker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let workerReady = false;
let pendingRequestId = 0;
/** Coarse bounds of the patch currently being computed in the worker. */
let pendingBounds: { x0: number; y0: number; x1: number; y1: number } | null = null;

type WorkerResponse =
  | { type: "ready" }
  | { type: "notReady"; requestId: number }
  | { type: "patch"; rawBuffer: ArrayBuffer; width: number; height: number;
      x0: number; y0: number; x1: number; y1: number;
      resScale: number; tier: 2 | 3; requestId: number };

patchWorker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;

  if (msg.type === "ready") {
    workerReady = true;
    // If we're already zoomed in and waiting, trigger a patch request now.
    if (getZoomTier(viewport.zoom) > 1 && !highResCache) render();

  } else if (msg.type === "notReady") {
    // Worker wasn't ready; it will send "ready" soon, which triggers render().

  } else if (msg.type === "patch") {
    if (msg.requestId !== pendingRequestId) return; // stale result — discard
    pendingBounds = null;
    const imageData = new ImageData(
      new Uint8ClampedArray(msg.rawBuffer), msg.width, msg.height,
    );
    highResCache = {
      tier: msg.tier,
      resScale: msg.resScale,
      x0: msg.x0, y0: msg.y0, x1: msg.x1, y1: msg.y1,
      buffer: imageData,
    };
    render();
  }
};

// --- Map dimensions ---
const MAP_WIDTH = 300;
const MAP_HEIGHT = 500;

// --- Canvas size (display resolution) ---
const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 600;

// --- UI Elements ---
const canvas      = document.getElementById("terrain")    as HTMLCanvasElement;
const seedInput   = document.getElementById("seed")       as HTMLInputElement;
const generateBtn = document.getElementById("generate")   as HTMLButtonElement;
const randomBtn   = document.getElementById("random")     as HTMLButtonElement;
const vegCheckbox = document.getElementById("vegetation") as HTMLInputElement;
const keyCheckbox = document.getElementById("show-key")   as HTMLInputElement;
const keyPanel    = document.getElementById("key-panel")  as HTMLElement;
const cursorInfo  = document.getElementById("cursor-info") as HTMLElement;
const zoomInfo    = document.getElementById("zoom-info")  as HTMLElement;
const worldStats  = document.getElementById("world-stats") as HTMLElement;

canvas.width  = CANVAS_WIDTH;
canvas.height = CANVAS_HEIGHT;

// --- Build key panel (static — content never changes) ---
renderKeyPanel(keyPanel);

// --- Zoom tier helpers ---
function getZoomTier(zoom: number): 1 | 2 | 3 {
  return zoom < 3 ? 1 : zoom < 8 ? 2 : 3;
}

/**
 * Computes the padded patch bounds (in coarse terrain coordinates) that
 * should be generated for the current viewport, capped to a sensible maximum
 * so generation stays fast. Also returns the raw visible-area corners for
 * cache-validity checking.
 */
function computePatchBounds(terrain: TerrainMap, vp: Viewport) {
  const baseScale = Math.min(canvas.width / terrain.width, canvas.height / terrain.height);
  const scale = baseScale * vp.zoom;
  const viewW = canvas.width / scale;
  const viewH = canvas.height / scale;
  let sx = Math.max(0, Math.min(terrain.width  - viewW, vp.cx - viewW / 2));
  let sy = Math.max(0, Math.min(terrain.height - viewH, vp.cy - viewH / 2));

  const tier = getZoomTier(vp.zoom);
  const pad  = tier === 2 ? 20 : 10;
  const maxW = tier === 2 ? 120 : 60;
  const maxH = tier === 2 ? 180 : 90;

  let x0 = Math.max(0, Math.floor(sx) - pad);
  let y0 = Math.max(0, Math.floor(sy) - pad);
  let x1 = Math.min(terrain.width,  Math.ceil(sx + viewW) + pad);
  let y1 = Math.min(terrain.height, Math.ceil(sy + viewH) + pad);

  if (x1 - x0 > maxW) {
    const cx = (x0 + x1) / 2;
    x0 = Math.floor(cx - maxW / 2);
    x1 = x0 + maxW;
  }
  if (y1 - y0 > maxH) {
    const cy = (y0 + y1) / 2;
    y0 = Math.floor(cy - maxH / 2);
    y1 = y0 + maxH;
  }

  return { x0, y0, x1, y1, viewSx: sx, viewSy: sy, viewW, viewH };
}

// --- Habitation overlay ---
function renderHabitationOverlay(): void {
  if (!currentTerrain || !currentSettlements || !currentPathNetwork || !currentSacred || !currentSeasonal) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cw = canvas.width, ch = canvas.height;
  const zoom = viewport.zoom;
  const baseScale = Math.min(cw / currentTerrain.width, ch / currentTerrain.height);
  const scale = baseScale * zoom;
  const viewW = cw / scale, viewH = ch / scale;
  const sx = Math.max(0, Math.min(currentTerrain.width  - viewW, viewport.cx - viewW / 2));
  const sy = Math.max(0, Math.min(currentTerrain.height - viewH, viewport.cy - viewH / 2));

  // Terrain grid → canvas pixels (centred on cell)
  const tc = (tx: number, ty: number): [number, number] =>
    [(tx + 0.5 - sx) * scale, (ty + 0.5 - sy) * scale];
  const vis = (px: number, py: number) =>
    px > -12 && px < cw + 12 && py > -12 && py < ch + 12;

  ctx.save();

  // ── Paths (3 passes: major → local → minor) ──────────────────────────────
  const pathStyles: [number, number, number, string, number][] = [
    // [minTraffic, maxTraffic, minZoom, color, lineWidth]
    // Thresholds match new population scale: town~250, village~70, hamlet~30, homestead~10
    [200, Infinity, 1.0, '#7a6a50', 1.0],   // trade route: warm brown 1px, all zoom
    [ 40, 199,      4.0, '#9a8a70', 0.5],   // local path: lighter brown 0.5px, zoom > 4
    // minor tracks (traffic < 40) not rendered — landscape should look mostly empty
  ];
  ctx.globalAlpha = 0.85;
  for (const [minT, maxT, minZ, color, lw] of pathStyles) {
    if (zoom < minZ) continue;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    for (const path of currentPathNetwork.paths) {
      const t = path.traffic;
      if (t < minT || t > maxT || path.cells.length < 2) continue;
      ctx.beginPath();
      const [x0, y0] = tc(path.cells[0][0], path.cells[0][1]);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < path.cells.length; i++) {
        const [xi, yi] = tc(path.cells[i][0], path.cells[i][1]);
        ctx.lineTo(xi, yi);
      }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // ── Fords ────────────────────────────────────────────────────────────────
  if (zoom >= 3) {
    ctx.fillStyle = '#00e5e5';
    ctx.strokeStyle = '#008888';
    ctx.lineWidth = 0.5;
    for (const f of currentSettlements.fords) {
      const [px, py] = tc(f.x, f.y);
      if (!vis(px, py)) continue;
      ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
  }

  // ── Abandoned settlements ─────────────────────────────────────────────────
  if (zoom >= 3) {
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    for (const s of currentSettlements.abandoned) {
      const [px, py] = tc(s.x, s.y);
      if (!vis(px, py)) continue;
      const r = s.historicalSize === 'homestead' ? 2 : s.historicalSize === 'hamlet' ? 3
              : s.historicalSize === 'village'   ? 4 : 5;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // ── Seasonal camps ────────────────────────────────────────────────────────
  if (zoom >= 3) {
    ctx.fillStyle = '#ffffff';
    for (const c of currentSeasonal.camps) {
      const [px, py] = tc(c.x, c.y);
      if (!vis(px, py)) continue;
      ctx.beginPath(); ctx.arc(px, py, 1.5, 0, Math.PI * 2); ctx.fill();
    }
    if (currentHunting) {
      ctx.fillStyle = '#ffffff';
      for (const circuit of currentHunting.circuits)
        for (const wp of circuit.waypoints) {
          const [px, py] = tc(wp.x, wp.y);
          if (!vis(px, py)) continue;
          ctx.beginPath(); ctx.arc(px, py, 1.5, 0, Math.PI * 2); ctx.fill();
        }
    }
  }

  // ── Small sacred features ─────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(200,176,112,0.65)';
  for (const s of currentSacred.small) {
    if (zoom < s.minZoom) continue;
    const [px, py] = tc(s.x, s.y);
    if (!vis(px, py)) continue;
    ctx.beginPath(); ctx.arc(px, py, zoom >= 8 ? 2 : 1.5, 0, Math.PI * 2); ctx.fill();
  }

  // ── Significant sacred sites ──────────────────────────────────────────────
  if (zoom >= 2) {
    ctx.fillStyle = '#c8b070';
    for (const s of currentSacred.significant) {
      const [px, py] = tc(s.x, s.y);
      if (!vis(px, py)) continue;
      ctx.beginPath(); ctx.arc(px, py, zoom >= 4 ? 3 : 2, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ── Major sacred sites ────────────────────────────────────────────────────
  for (const s of currentSacred.major) {
    const [px, py] = tc(s.x, s.y);
    if (!vis(px, py)) continue;
    const r = zoom >= 3 ? 5 : 4;
    ctx.fillStyle = '#c09020';
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#c09020';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(px, py, r + 3, 0, Math.PI * 2); ctx.stroke();
  }

  // ── Settlements ───────────────────────────────────────────────────────────
  for (const s of currentSettlements.settlements) {
    if (s.size === 'homestead' && zoom < 3) continue;
    if (s.size === 'hamlet'    && zoom < 2) continue;
    const [px, py] = tc(s.x, s.y);
    if (!vis(px, py)) continue;
    const r = s.isWalledTown ? 5 : s.size === 'town' ? 5 : s.size === 'village' ? 3
            : s.size === 'hamlet' ? 2 : 1.5;
    ctx.fillStyle = '#dd3333';
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    if (s.isWalledTown) {
      ctx.strokeStyle = '#c09020';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, py, r + 2.5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  ctx.restore();
}

// --- Habitation hover info ---
function getHabitationHover(tx: number, ty: number): string {
  const parts: string[] = [];

  if (currentSettlements) {
    let nearest = null as typeof currentSettlements.settlements[0] | null;
    let nd = Infinity;
    for (const s of currentSettlements.settlements) {
      const d = Math.hypot(s.x - tx, s.y - ty);
      if (d < 2.5 && d < nd) { nd = d; nearest = s; }
    }
    if (nearest) {
      const lbl = nearest.isWalledTown ? 'Walled town'
        : nearest.size === 'town' ? 'Town' : nearest.size === 'village' ? 'Village'
        : nearest.size === 'hamlet' ? 'Hamlet' : 'Homestead';
      parts.push(`${lbl} · pop ~${nearest.population}`);
    }
    let nearestAb = null as typeof currentSettlements.abandoned[0] | null;
    let nda = Infinity;
    for (const s of currentSettlements.abandoned) {
      const d = Math.hypot(s.x - tx, s.y - ty);
      if (d < 2.5 && d < nda) { nda = d; nearestAb = s; }
    }
    if (nearestAb) {
      const why = nearestAb.reason === 'waterRose' ? 'flooded'
        : nearestAb.reason === 'iceAdvanced' ? 'iced over' : 'marginal';
      parts.push(`Abandoned ${nearestAb.historicalSize} (${why})`);
    }
    for (const f of currentSettlements.fords)
      if (Math.hypot(f.x - tx, f.y - ty) < 1.5) { parts.push('Ford'); break; }
  }

  if (currentSacred) {
    for (const s of currentSacred.major)
      if (Math.hypot(s.x - tx, s.y - ty) < 3) {
        parts.push(s.type === 'greatComplex' ? 'Great ceremonial complex'
          : s.type === 'henge' ? 'Henge' : 'Stone circle');
        break;
      }
    for (const s of currentSacred.significant)
      if (Math.hypot(s.x - tx, s.y - ty) < 2) {
        parts.push(s.type === 'barrow' ? 'Barrow' : s.type === 'standingStone' ? 'Standing stone'
          : s.type === 'smallStoneCircle' ? 'Small stone circle' : 'Cairn');
        break;
      }
    if (viewport.zoom >= 5) {
      const SMALL_LABELS: Record<string, string> = {
        sacredSpring: 'Sacred spring', offeringPool: 'Offering pool',
        caveEntrance: 'Cave entrance', sacredTree: 'Sacred tree',
        carvedRockFace: 'Carved rock face', markedStone: 'Marked stone',
      };
      for (const s of currentSacred.small)
        if (Math.hypot(s.x - tx, s.y - ty) < 1.5) {
          parts.push(SMALL_LABELS[s.type] ?? s.type); break;
        }
    }
  }

  if (pathLookup) {
    let bestT = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        bestT = Math.max(bestT, pathLookup.get((ty + dy) * MAP_WIDTH + (tx + dx)) ?? 0);
    if (bestT > 0)
      parts.push(bestT > 200 ? `Trade route (traffic ${Math.round(bestT)})`
        : bestT > 40  ? `Local path (traffic ${Math.round(bestT)})` : 'Track');
  }

  if (currentSeasonal && viewport.zoom >= 3) {
    const CAMP_LABELS: Record<string, string> = {
      grazingCamp: 'Upland grazing camp', fishingCamp: 'Fishing camp',
      gatheringCamp: 'Gathering camp', flintMiningCamp: 'Flint-mining camp',
      tradingSite: 'Trading site',
    };
    for (const c of currentSeasonal.camps)
      if (Math.hypot(c.x - tx, c.y - ty) < 1.5) {
        parts.push(CAMP_LABELS[c.type] ?? c.type); break;
      }
  }

  return parts.length > 0 ? ' · ' + parts.join(' · ') : '';
}

// --- Render current state ---
function render(): void {
  if (!currentTerrain || !currentBuffer) return;

  const tier = getZoomTier(viewport.zoom);

  if (tier === 1) {
    highResCache = null;
    pendingBounds = null;
    renderViewport(canvas, currentBuffer, currentTerrain, viewport);
    renderHabitationOverlay();
    updateZoomDisplay();
    return;
  }

  const resScale = tier === 2 ? 8 : 16;
  const bounds = computePatchBounds(currentTerrain, viewport);

  const cacheValid =
    highResCache !== null &&
    highResCache.tier === tier &&
    bounds.viewSx >= highResCache.x0 &&
    bounds.viewSy >= highResCache.y0 &&
    bounds.viewSx + bounds.viewW <= highResCache.x1 &&
    bounds.viewSy + bounds.viewH <= highResCache.y1;

  if (!cacheValid) {
    // Progressive fallback: show the coarse buffer immediately so the map is
    // never blank while the worker computes the fine patch.
    renderViewport(canvas, currentBuffer, currentTerrain, viewport);
    renderHabitationOverlay();
    updateZoomDisplay();

    // Only send a new request if the viewport has moved outside the patch the
    // worker is already computing — avoids flooding it during fast panning.
    const needsNewRequest =
      !pendingBounds ||
      bounds.viewSx < pendingBounds.x0 ||
      bounds.viewSy < pendingBounds.y0 ||
      bounds.viewSx + bounds.viewW > pendingBounds.x1 ||
      bounds.viewSy + bounds.viewH > pendingBounds.y1;

    if (needsNewRequest && workerReady) {
      pendingRequestId++;
      pendingBounds = { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: bounds.y1 };
      patchWorker.postMessage({
        type: "patch",
        x0: bounds.x0, y0: bounds.y0,
        w: bounds.x1 - bounds.x0,
        h: bounds.y1 - bounds.y0,
        resScale, showVegetation,
        requestId: pendingRequestId,
      });
    }
    return;
  }

  renderHighResViewport(canvas, highResCache!, viewport, currentTerrain);
  renderHabitationOverlay();
  updateZoomDisplay();
}

function updateZoomDisplay(): void {
  const tier = getZoomTier(viewport.zoom);
  const tierLabel = tier === 1 ? "" : ` · tier ${tier}`;
  const zoomLine = `Zoom: ${viewport.zoom.toFixed(1)}×${tierLabel}`;

  let scaleLine = "";
  if (currentTerrain) {
    // Compute how many coarse cells (≈ miles) fit across the visible canvas.
    const baseScale = Math.min(
      canvas.width / currentTerrain.width,
      canvas.height / currentTerrain.height,
    );
    const viewW = canvas.width / (baseScale * viewport.zoom); // visible miles
    // canvas.clientWidth is the rendered CSS-pixel width of the canvas element.
    // 1 inch = 96 CSS px (standard); 1 cm = 96/2.54 CSS px.
    const cssPx = canvas.clientWidth || canvas.width;
    const miPerIn = viewW * 96 / cssPx;
    const kmPerCm = miPerIn * 1.60934 / 2.54;
    scaleLine = `1 in ≈ ${fmtMi(miPerIn)} · 1 cm ≈ ${fmtKm(kmPerCm)}`;
  }

  zoomInfo.innerHTML = zoomLine + (scaleLine ? `<br>${scaleLine}` : "");
}

function fmtMi(mi: number): string {
  if (mi >= 10)  return `${Math.round(mi)} mi`;
  if (mi >= 0.1) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi * 1760)} yd`;
}

function fmtKm(km: number): string {
  if (km >= 10)  return `${Math.round(km)} km`;
  if (km >= 0.1) return `${km.toFixed(1)} km`;
  return `${Math.round(km * 1000)} m`;
}

// --- Cell lookup ---
// Fine terrain lives in the worker, so cursor inspection always uses the
// coarse cell. Geology and coast/river status are identical; altitude is
// within ~30 m of the fine value, which is imperceptible in the tooltip.
function getHoveredCell(clientX: number, clientY: number): TerrainCell | null {
  if (!currentTerrain) return null;
  const pos = canvasToTerrain(canvas, currentTerrain, viewport, clientX, clientY);
  if (!pos) return null;
  return currentTerrain.cells[pos.y][pos.x];
}

// --- Food resource diagnostics ---
function logFoodStats(fm: FoodResourceMap): void {
  const n = fm.grid.length;
  let sumDeer = 0, sumFish = 0, sumWildfowl = 0, sumWolf = 0, sumBear = 0;
  for (const r of fm.grid) {
    sumDeer     += r.deer;
    sumFish     += r.fish;
    sumWildfowl += r.wildfowl;
    sumWolf     += r.wolfRisk;
    sumBear     += r.bearRisk;
  }
  console.log(
    `[Food] deer avg ${(sumDeer/n).toFixed(3)}` +
    ` · fish avg ${(sumFish/n).toFixed(3)}` +
    ` · wildfowl avg ${(sumWildfowl/n).toFixed(3)}` +
    ` · wolf avg risk ${(sumWolf/n).toFixed(3)} (${fm.wolfTerritories.length} packs)` +
    ` · bear avg risk ${(sumBear/n).toFixed(3)} (${fm.bearRanges.length} ranges)`
  );
}

function logSettlementStats(sd: SettlementData): void {
  const { settlements, fords, abandoned } = sd;
  const land = settlements.filter(s => !s.isWaterLands);
  const wl   = settlements.filter(s => s.isWaterLands);
  const totalPop = settlements.reduce((s, t) => s + t.population, 0);
  const walled = settlements.find(s => s.isWalledTown);
  const bySz = (sz: string) => land.filter(s => s.size === sz).length;
  const byReason = (r: string) => abandoned.filter(a => a.reason === r).length;
  console.log(
    `[Settlements] ${settlements.length} total (${land.length} land, ${wl.length} water-lands)` +
    ` · pop ${totalPop.toLocaleString()}` +
    ` · towns ${bySz('town')}, villages ${bySz('village')}, hamlets ${bySz('hamlet')}, homesteads ${bySz('homestead')}` +
    ` · fords ${fords.length}` +
    (walled ? ` · walled town @ (${walled.x},${walled.y}) pop ${walled.population}` : '')
  );
  console.log(
    `[Abandoned] ${abandoned.length} sites` +
    ` · waterRose ${byReason('waterRose')}, iceAdvanced ${byReason('iceAdvanced')}, landMarginal ${byReason('landMarginal')}`
  );
}

function logValidationStats(vr: ValidationReport): void {
  console.group('[Validation]');
  for (const line of vr.summary) console.log(line);
  console.groupEnd();
}

function logHuntingStats(hd: HuntingData): void {
  const { circuits } = hd;
  const sizes = circuits.map(c => c.groupSize);
  const avgSize = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;
  const totalPathCells = circuits.reduce((s, c) => s + c.pathCells.length, 0);
  console.log(
    `[Hunting] ${circuits.length} circuits · group sizes ${sizes.join(', ')}` +
    ` · avg size ${avgSize} · total routed cells ${totalPathCells}`
  );
}

function logSeasonalStats(sd: SeasonalData): void {
  const byType = (t: string) => sd.camps.filter(c => c.type === t).length;
  console.log(
    `[Seasonal] ${sd.camps.length} camps total` +
    ` · grazing ${byType('grazingCamp')}` +
    ` · fishing ${byType('fishingCamp')}` +
    ` · gathering ${byType('gatheringCamp')}` +
    ` · flint-mining ${byType('flintMiningCamp')}` +
    ` · trading ${byType('tradingSite')}`
  );
}

function logSacredStats(sd: SacredData): void {
  const byType = (arr: { type: string }[], t: string) => arr.filter(s => s.type === t).length;
  const maj = sd.major.map(s => s.type).join(', ') || 'none';
  const sigTypes = ['standingStone','barrow','smallStoneCircle','cairn'];
  const smTypes  = ['markedStone','sacredSpring','offeringPool','caveEntrance','sacredTree','carvedRockFace'];
  const sigBreak = sigTypes.map(t => `${t} ×${byType(sd.significant, t)}`).filter(s => !s.endsWith('×0')).join(', ');
  const smBreak  = smTypes.map(t =>  `${t} ×${byType(sd.small, t)}`).filter(s => !s.endsWith('×0')).join(', ');
  console.log(
    `[Sacred] major (${sd.major.length}): ${maj}` +
    ` · significant (${sd.significant.length}): ${sigBreak}` +
    ` · small (${sd.small.length}): ${smBreak}`
  );
}

function logPathStats(pn: PathNetwork): void {
  const { paths } = pn;
  const major  = paths.filter(p => p.traffic > 500).length;
  const local  = paths.filter(p => p.traffic > 100 && p.traffic <= 500).length;
  const minor  = paths.filter(p => p.traffic <= 100).length;
  const maxT   = paths.reduce((m, p) => Math.max(m, p.traffic), 0);
  const totalCells = paths.reduce((s, p) => s + p.cells.length, 0);
  console.log(
    `[Paths] ${paths.length} segments · major ${major}, local ${local}, minor ${minor}` +
    ` · peak traffic ${maxT} · total path cells ${totalCells}`
  );
}

function logCarryingStats(cc: CarryingCapacity): void {
  const { habitability: h } = cc;
  let sum = 0, nonZero = 0, high = 0;
  for (const v of h) {
    sum += v;
    if (v > 0) nonZero++;
    if (v > 0.6) high++;
  }
  console.log(
    `[Carrying] mean hab ${(sum / h.length).toFixed(3)}` +
    ` · habitable cells ${nonZero}/${h.length}` +
    ` · high-hab (>0.6) cells ${high}`
  );
}

function logWightStats(w: WightData): void {
  const caveOcc = w.caveWights.filter(t => t.occupied).length;
  const sfOcc   = w.smallFolk.filter(t => t.occupied).length;
  console.log(
    `[Wights] cave-wight sites: ${w.caveWights.length} total, ${caveOcc} occupied` +
    ` · small-folk sites: ${w.smallFolk.length} total, ${sfOcc} occupied`
  );
}

// --- Generate terrain ---
function generate(seed: string): void {
  const startTime = performance.now();

  const noise = createSeededNoise(seed);
  currentTerrain = generateTerrain(noise, MAP_WIDTH, MAP_HEIGHT, seed);
  bakeVegetationNoise(currentTerrain);
  currentBuffer = renderTerrainToBuffer(currentTerrain, showVegetation);
  currentFoodMap = computeFoodResources(currentTerrain, seed);
  logFoodStats(currentFoodMap);
  currentWightData = generateWightTerritories(currentTerrain, seed);
  logWightStats(currentWightData);
  currentCarrying = computeCarryingCapacity(currentTerrain, currentFoodMap, currentWightData);
  logCarryingStats(currentCarrying);
  currentSettlements = computeSettlements(currentTerrain, currentFoodMap, currentCarrying, currentWightData);
  logSettlementStats(currentSettlements);
  currentPathNetwork = computePathNetwork(currentTerrain, currentSettlements);
  logPathStats(currentPathNetwork);
  pathLookup = new Map();
  for (const p of currentPathNetwork.paths)
    for (const [px, py] of p.cells) {
      const i = py * MAP_WIDTH + px;
      if ((pathLookup.get(i) ?? 0) < p.traffic) pathLookup.set(i, p.traffic);
    }
  currentSacred = computeSacredSites(currentTerrain, currentFoodMap, currentSettlements, currentPathNetwork, currentWightData, seed);
  logSacredStats(currentSacred);
  currentSeasonal = computeSeasonalCamps(currentTerrain, currentFoodMap, currentSettlements, currentPathNetwork, currentSacred, seed);
  logSeasonalStats(currentSeasonal);
  currentHunting = computeHuntingCircuits(currentTerrain, currentFoodMap, currentSettlements, seed);
  logHuntingStats(currentHunting);
  currentValidation = validateHabitation(currentTerrain, currentSettlements, currentPathNetwork, currentSacred);
  logValidationStats(currentValidation);
  highResCache = null;
  pendingBounds = null;
  pendingRequestId++; // invalidate any in-flight patch from the previous map
  workerReady = false;
  patchWorker.postMessage({ type: "prepare", seed });

  // Reset viewport to show whole map
  viewport = {
    cx: MAP_WIDTH / 2,
    cy: MAP_HEIGHT / 2,
    zoom: 1,
  };

  render();

  if (currentSettlements && currentSacred) {
    const s = currentSettlements;
    const totalPop   = s.settlements.reduce((n, t) => n + t.population, 0);
    const walledTowns = s.settlements.filter(t => t.isWalledTown).length;
    worldStats.textContent =
      `Population ~${totalPop.toLocaleString()}  ·  ` +
      `${s.settlements.length} settlements (${walledTowns} walled)  ·  ` +
      `${s.abandoned.length} abandoned  ·  ` +
      `${currentSacred.major.length} major / ${currentSacred.significant.length} significant / ${currentSacred.small.length} small sacred sites`;
  }

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

keyCheckbox.addEventListener("change", () => {
  showKey = keyCheckbox.checked;
  keyPanel.classList.toggle("hidden", !showKey);
});

vegCheckbox.addEventListener("change", () => {
  showVegetation = vegCheckbox.checked;
  if (!currentTerrain) return;
  // Coarse buffer re-renders from baked noise — fast, no noise recomputation.
  currentBuffer = renderTerrainToBuffer(currentTerrain, showVegetation);
  // Invalidate the fine cache; render() will show coarse fallback immediately
  // and dispatch a new patch request to the worker with updated showVegetation.
  highResCache = null;
  pendingBounds = null;
  render();
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

canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    isDragging = true;
    dragStartCx = viewport.cx;
    dragStartCy = viewport.cy;
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
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
  const cell = pos ? currentTerrain.cells[pos.y][pos.x] : null;
  if (cell && pos) {
    const info = GEOLOGY_INFO[cell.geology];
    const altMetres = Math.round(cell.altitude * 1200);
    const river = cell.riverFlow > 0 ? " · River" : "";
    const coast = cell.isCoast ? " · Coast" : "";
    const hab = getHabitationHover(pos.x, pos.y);
    cursorInfo.textContent =
      `${info.label} · ${altMetres}m${river}${coast}${hab} — ${info.description}`;
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

