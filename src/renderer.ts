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
