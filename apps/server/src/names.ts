import type { MerchantCategory } from "@rescu/live";
import type { Rng } from "./rng.js";

// Fictional store names only: the sim plants price gougers, so no real brands.
const PLACES = [
  "Live Oak", "Cypress", "Pelican", "Heron", "Bayou", "Harbor", "Gulf Breeze", "Palmetto", "Pine Ridge", "Riverside",
  "Lakeside", "Sandhill", "Laurel", "Dogwood", "Tidewater", "Coastal", "Marsh Creek", "Cedar", "Oakwood", "Willow",
  "Sawgrass", "Mockingbird", "Red Clay", "Hickory", "Crescent", "Seabreeze", "Twin Rivers", "Old Mill", "Main Street",
  "Depot Street", "Courthouse", "Blue Heron", "Saltmarsh", "Longleaf", "Pecan Grove", "Tupelo", "Sweetgum", "Iron Bridge",
  "Mill Pond", "Wiregrass", "Sea Oats", "Whitewater", "Stillwater", "Clearwater Road", "High Bluff", "Shady Grove",
];

const KINDS: Record<MerchantCategory, string[]> = {
  pharmacy: ["Pharmacy", "Drugs", "Apothecary", "Community Pharmacy", "Rx & Wellness"],
  grocery: ["Grocery", "Foods", "Provisions", "Grocers", "Food Store", "Market & Deli"],
  hardware: ["Hardware", "Building Supply", "Lumber & Supply", "Tool & Supply", "Home Supply"],
  general: ["General Store", "Mercantile", "Trading Post", "Corner Store", "Country Store", "Fuel & Goods"],
};

/** Unique within a run; half are named after their county ("Buncombe Hardware"). */
export function merchantName(rng: Rng, category: MerchantCategory, county: string, taken: Set<string>): string {
  const base = county.replace(/ (County|Parish|city|City)$/, "");
  for (let attempt = 0; attempt < 20; attempt++) {
    const place = rng.chance(0.45) ? base : rng.pick(PLACES);
    const name = `${place} ${rng.pick(KINDS[category])}`;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
  const name = `${rng.pick(PLACES)} ${rng.pick(KINDS[category])} #${taken.size + 1}`;
  taken.add(name);
  return name;
}
