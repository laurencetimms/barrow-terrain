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
