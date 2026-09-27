import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

/** Deep-sea blue: clearly an ocean at world view, a touch deeper at storm zoom so hexes win. */
const WATER_FAR = "#0d2c4d";
const WATER_NEAR = "#09203a";
const WOOD = "#1f3d2a";
const PARK = "#1f3d2a";
const waterFill = ["interpolate", ["linear"], ["zoom"], 0, WATER_FAR, 3, "#0b2644", 6, WATER_NEAR] as unknown[];
const HIDDEN = /^(aeroway|road_|highway_name|railway|building|water_name|place_other|place_suburb|place_village)/;

/**
 * Natural Earth II shaded relief under the vector layers, in its real greens and tans (the east
 * is forest, the west is range), slightly muted and dimmed so it reads natural and the data wins.
 */
const RELIEF: LayerSpecification = {
  id: "relief",
  type: "raster",
  source: "ne2_shaded",
  paint: {
    "raster-saturation": -0.1,
    "raster-hue-rotate": 6,
    "raster-brightness-min": 0.03,
    "raster-brightness-max": 0.52,
    "raster-contrast": 0.18,
    "raster-opacity": 1,
  },
};

/**
 * OpenFreeMap's dark style, recoloured: natural green-and-tan land with real relief over a deep
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
    paint["fill-opacity"] = 0.16;
  } else if (id === "landuse_park") {
    paint["fill-color"] = PARK;
    paint["fill-opacity"] = 0.1;
  } else if (id.startsWith("landcover_ice") || id.startsWith("landcover_glacier")) {
    paint["fill-color"] = "#1a2830";
    paint["fill-opacity"] = 0.35;
  } else if (id.startsWith("landcover") || id.startsWith("landuse")) {
    paint["fill-color"] = "#12241a";
    paint["fill-opacity"] = 0;
  } else if (id.startsWith("highway")) {
    paint["line-color"] = id.includes("casing") ? "rgba(0,0,0,0)" : "#26352c";
    paint["line-opacity"] = ["interpolate", ["linear"], ["zoom"], 5, 0.28, 9, 0.7];
  } else if (id === "boundary_state") {
    paint["line-color"] = "#5c7266";
    paint["line-opacity"] = 0.85;
  } else if (id.startsWith("boundary_country")) {
    paint["line-color"] = "#7a8f83";
  } else if (id.startsWith("place_")) {
    const major = id === "place_city_large" || id === "place_state" || id.startsWith("place_country");
    paint["text-color"] = major ? "#e6ece8" : "#bcc7c0";
    paint["text-halo-color"] = "rgba(5,14,22,0.7)";
    paint["text-halo-width"] = 1.1;
    paint["text-halo-blur"] = 0.9;
    if (l.layout && "icon-image" in l.layout) delete l.layout["icon-image"];
    delete paint["icon-opacity"];
    if (id === "place_state") {
      const layout = (l.layout ??= {});
      layout["text-transform"] = "uppercase";
      layout["text-letter-spacing"] = 0.18;
      paint["text-color"] = "rgba(226,234,229,0.62)";
    }
  }
  return l;
}

/** Id of the first label layer, so data can sit under the city names. */
export function firstLabelLayer(style: StyleSpecification): string | undefined {
  return style.layers.find((l) => l.type === "symbol")?.id;
}
