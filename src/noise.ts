import { createNoise2D } from "simplex-noise";

// Simple seedable PRNG (mulberry32)
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Convert string seed to number
function hashSeed(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash;
}

export interface NoiseGenerator {
  noise2D: (x: number, y: number) => number;
  random: () => number;
}

export function createSeededNoise(seed: string): NoiseGenerator {
  const numSeed = hashSeed(seed);
  const rng = mulberry32(numSeed);
  const noise2D = createNoise2D(rng);
  // Create a second rng stream for general random use
  const rng2 = mulberry32(numSeed + 12345);
  return { noise2D, random: rng2 };
}

// Layered noise: combine multiple octaves for natural-looking terrain
export function layeredNoise(
  noise2D: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves: number = 6,
  persistence: number = 0.5,
  lacunarity: number = 2.0,
  scale: number = 1.0
): number {
  let value = 0;
  let amplitude = 1;
  let frequency = scale;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    value += noise2D(x * frequency, y * frequency) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  return value / maxValue; // Normalise to roughly -1..1
}
