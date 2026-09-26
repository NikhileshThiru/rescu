/** Design tokens for code that can't read CSS (deck.gl, MapLibre). Mirrors globals.css @theme. */

export type RGB = [number, number, number];

export function hex(h: string): RGB {
  const n = Number.parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const color = {
  bg: "#070b14",
  surface1: "#0c1220",
  surface2: "#111a2c",
  surface3: "#18233a",
  text: "#e6edf7",
  text2: "#9aa8bd",
  text3: "#7c8aa0",
  teal: "#2dd4bf",
  amber: "#f5b83d",
  red: "#f0616d",
  storm: "#dce8ff",
} as const;

/** Wind ramp by kt, validated as ordinal on the base colour. */
export const WIND_STOPS: [kt: number, rgb: RGB][] = [
  [25, hex("#34507f")],
  [40, hex("#4f74b0")],
  [64, hex("#86a8e2")],
  [100, hex("#dce8ff")],
];

/** Aid ramp by dollars per eligible household. */
export const AID_STOPS: [usd: number, rgb: RGB][] = [
  [250, hex("#1b5c57")],
  [600, hex("#1c8078")],
  [1000, hex("#1fa596")],
  [1500, hex("#46cdbb")],
  [2000, hex("#a4f2e4")],
];

export function ramp(stops: [number, RGB][], x: number, out: RGB = [0, 0, 0]): RGB {
  if (x <= stops[0]![0]) return copy(stops[0]![1], out);
  for (let i = 1; i < stops.length; i++) {
    const [x1, c1] = stops[i]!;
    if (x <= x1) {
      const [x0, c0] = stops[i - 1]!;
      const f = (x - x0) / (x1 - x0);
      out[0] = c0[0] + (c1[0] - c0[0]) * f;
      out[1] = c0[1] + (c1[1] - c0[1]) * f;
      out[2] = c0[2] + (c1[2] - c0[2]) * f;
      return out;
    }
  }
  return copy(stops[stops.length - 1]![1], out);
}

function copy(c: RGB, out: RGB): RGB {
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  return out;
}
