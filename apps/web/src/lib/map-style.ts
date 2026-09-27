import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

/** A rich ocean blue: clearly a sea at world view, a little deeper at storm zoom so hexes win. */
const WATER_FAR = "#0b4f7e";
const WATER_NEAR = "#083a62";
const WOOD = "#1f5e38";
const PARK = "#1f5e38";
const waterFill = ["interpolate", ["linear"], ["zoom"], 0, WATER_FAR, 3, "#0a4572", 6, WATER_NEAR] as unknown[];
const HIDDEN = /^(aeroway|road_|highway_name|railway|building|water_name|place_other|place_suburb|place_village)/;

/**
 * Natural Earth II shaded relief under the vector layers, in its real greens and tans (the east
 * is forest, the west is range), lifted and a little more saturated so the map reads vivid, not muddy.
 */
const RELIEF: LayerSpecification = {
  id: "relief",
  type: "raster",
  source: "ne2_shaded",
  paint: {
    "raster-saturation": 0.3,
    "raster-brightness-min": 0.04,
    "raster-brightness-max": 0.66,
    "raster-contrast": 0.12,
    "raster-opacity": 1,
  },
};

/**
 * OpenFreeMap's dark style, recoloured: natural green-and-tan land with real relief over a rich
 * blue sea, quiet roads, readable labels. POIs, rail, road names and buildings stay off.
 */
export async function loadMapStyle(): Promise<StyleSpecification> {
  const style = (await (await fetch(STYLE_URL)).json()) as StyleSpecification;
  const layers = style.layers.filter((l) => !HIDDEN.test(l.id)).map(recolor);
  const water = layers.findIndex((l) => l.id === "water");
  if (style.sources.ne2_shaded && water >= 0) layers.splice(water, 0, RELIEF);
  style.layers = layers;
  return style;
}

function recolor(layer: LayerSpecification): LayerSpecification {
  const l = structuredClone(layer) as LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown> };
  const paint = (l.paint ??= {});
  const id = l.id;
  if (id === "background") paint["background-color"] = WATER_FAR;
  else if (id === "water") {
    paint["fill-color"] = waterFill;
    paint["fill-opacity"] = 1;
  } else if (id === "waterway") {
    paint["line-color"] = WATER_NEAR;
  } else if (id === "landcover_wood") {
    paint["fill-color"] = WOOD;
    paint["fill-opacity"] = ["interpolate", ["linear"], ["zoom"], 3, 0.15, 7, 0.3];
  } else if (id === "landuse_park") {
    paint["fill-color"] = PARK;
    paint["fill-opacity"] = ["interpolate", ["linear"], ["zoom"], 3, 0.1, 7, 0.25];
  } else if (id.startsWith("landcover_ice") || id.startsWith("landcover_glacier")) {
    paint["fill-color"] = "#1a2830";
    paint["fill-opacity"] = 0.35;
  } else if (id.startsWith("landcover") || id.startsWith("landuse")) {
    paint["fill-color"] = "#12241a";
    paint["fill-opacity"] = 0;
  } else if (id.startsWith("highway")) {
    paint["line-color"] = id.includes("casing") ? "rgba(0,0,0,0)" : "#2c4636";
    paint["line-opacity"] = ["interpolate", ["linear"], ["zoom"], 5, 0.28, 9, 0.7];
  } else if (id === "boundary_state") {
    paint["line-color"] = "#6f8f7c";
    paint["line-opacity"] = 0.85;
  } else if (id.startsWith("boundary_country")) {
    paint["line-color"] = "#8aa896";
  } else if (id.startsWith("place_")) {
    const major = id === "place_city_large" || id === "place_state" || id.startsWith("place_country");
    paint["text-color"] = major ? "#eef4f0" : "#d2ddd6";
    paint["text-halo-color"] = "rgba(6,20,26,0.55)";
    paint["text-halo-width"] = 1.1;
    paint["text-halo-blur"] = 0.9;
    if (l.layout && "icon-image" in l.layout) delete l.layout["icon-image"];
    delete paint["icon-opacity"];
    if (id === "place_state") {
      const layout = (l.layout ??= {});
      layout["text-transform"] = "uppercase";
      layout["text-letter-spacing"] = 0.18;
      paint["text-color"] = "rgba(236,243,238,0.72)";
    }
  }
  return l;
}

/** Id of the first label layer, so data can sit under the city names. */
export function firstLabelLayer(style: StyleSpecification): string | undefined {
  return style.layers.find((l) => l.type === "symbol")?.id;
}
