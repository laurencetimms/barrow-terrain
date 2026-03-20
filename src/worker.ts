/**
 * Terrain patch worker.
 *
 * Runs entirely off the main thread. Handles two message types:
 *
 *   prepare { seed }
 *     Generate and cache the coarse map from the given seed.
 *     Replies with { type: 'ready' } when done.
 *
 *   patch { x0, y0, w, h, resScale, showVegetation, requestId }
 *     Generate a fine-resolution patch using the cached coarse map,
 *     bake vegetation noise, render to ImageData, and transfer the raw
 *     ArrayBuffer back (zero-copy). Replies with { type: 'patch', ... }.
 *
 * Using `self as any` avoids TypeScript DOM/WebWorker lib conflicts while
 * keeping the tsconfig unchanged.
 */

import { createSeededNoise } from "./noise";
import { generateTerrain, generateHighResPatch, TerrainMap } from "./terrain";
import { renderTerrainToBuffer, bakeVegetationNoise } from "./renderer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = self as any;

const MAP_WIDTH  = 300;
const MAP_HEIGHT = 500;

let coarseMap:   TerrainMap | null = null;
let coarseNoise: ReturnType<typeof createSeededNoise> | null = null;

type InMessage =
  | { type: "prepare"; seed: string }
  | { type: "patch"; x0: number; y0: number; w: number; h: number;
      resScale: number; showVegetation: boolean; requestId: number };

ctx.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;

  if (msg.type === "prepare") {
    const noise = createSeededNoise(msg.seed);
    coarseNoise  = noise;
    coarseMap    = generateTerrain(noise, MAP_WIDTH, MAP_HEIGHT, msg.seed);
    bakeVegetationNoise(coarseMap);
    ctx.postMessage({ type: "ready" });

  } else if (msg.type === "patch") {
    if (!coarseMap || !coarseNoise) {
      ctx.postMessage({ type: "notReady", requestId: msg.requestId });
      return;
    }

    const { x0, y0, w, h, resScale, showVegetation, requestId } = msg;

    const patch = generateHighResPatch(coarseMap, coarseNoise, x0, y0, w, h, resScale);
    bakeVegetationNoise(patch);
    const buffer = renderTerrainToBuffer(patch, showVegetation);

    // Transfer the underlying ArrayBuffer so the copy is zero-cost.
    const rawBuffer = buffer.data.buffer;
    ctx.postMessage(
      {
        type: "patch",
        rawBuffer,
        width:   patch.width,
        height:  patch.height,
        x0, y0,
        x1: x0 + w,
        y1: y0 + h,
        resScale,
        tier: resScale === 8 ? 2 : 3,
        requestId,
      },
      [rawBuffer],
    );
  }
};
