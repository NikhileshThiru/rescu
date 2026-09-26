import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

const LAND = "#111a2b";
const WATER = "#070b15";
const HIDDEN = /^(aeroway|road_|highway_name|railway|building|landcover_wood|water_name|place_other|place_suburb|place_village)/;

/**
 * Natural Earth II shaded relief (already served with the style) under the vector layers, cooled
 * to near-grey so the real terrain reads (mountains, rivers, lakes, coastlines) without competing
 * with the storm's blues or the aid's teal. The opaque water fill on top keeps coastlines crisp.
 */
const RELIEF: LayerSpecification = {
  id: "relief",
  type: "raster",
  source: "ne2_shaded",
  paint: {
    "raster-saturation": -0.8,
    "raster-brightness-min": 0.03,
    "raster-brightness-max": 0.5,
    "raster-contrast": 0.15,
    "raster-opacity": 0.82,
  },
};

/**
 * OpenFreeMap's dark style, recoloured to the Rescu palette: navy land with real relief over
 * near-black water, whisper-quiet roads, readable labels, and anything that competes with the
 * data (POIs, rail, road names, buildings) switched off.
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
  if (id === "background") paint["background-color"] = LAND;
  else if (id === "water") paint["fill-color"] = WATER;
  else if (id === "waterway") {
    paint["line-color"] = WATER;
  } else if (id.startsWith("landcover") || id.startsWith("landuse")) {
    paint["fill-color"] = "#0d1424";
    paint["fill-opacity"] = 0.5;
  } else if (id.startsWith("highway")) {
    paint["line-color"] = id.includes("casing") ? "rgba(0,0,0,0)" : "#18223a";
    paint["line-opacity"] = ["interpolate", ["linear"], ["zoom"], 5, 0.35, 9, 0.8];
  } else if (id === "boundary_state") {
    paint["line-color"] = "#3d4e6e";
    paint["line-opacity"] = 0.9;
  } else if (id.startsWith("boundary_country")) {
    paint["line-color"] = "#4a5b7c";
  } else if (id.startsWith("place_")) {
    const major = id === "place_city_large" || id === "place_state" || id.startsWith("place_country");
    paint["text-color"] = major ? "#a9b5c9" : "#8391a8";
    paint["text-halo-color"] = "rgba(7,11,20,0.8)";
    paint["text-halo-width"] = 1.2;
    paint["text-halo-blur"] = 0.6;
    if (l.layout && "icon-image" in l.layout) delete l.layout["icon-image"];
    delete paint["icon-opacity"];
    if (id === "place_state") {
      const layout = (l.layout ??= {});
      layout["text-transform"] = "uppercase";
      layout["text-letter-spacing"] = 0.18;
      paint["text-color"] = "#76849c";
    }
  }
  return l;
}

/** Id of the first label layer, so data can sit under the city names. */
export function firstLabelLayer(style: StyleSpecification): string | undefined {
  return style.layers.find((l) => l.type === "symbol")?.id;
}
