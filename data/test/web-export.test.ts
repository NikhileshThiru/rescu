/**
 * Guards the map data the Command Center reads (apps/web/public/data, written by export-web):
 * every hex and county adds back up to the aid pot, amounts stay inside the rule's band, and the
 * columns the frame loop indexes are consistent. A broken export fails here, not on stage.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { getResolution, isValidCell } from "h3-js";
import { describe, expect, it } from "vitest";

const DIR = new URL("../../apps/web/public/data/", import.meta.url);
const listing = JSON.parse(readFileSync(new URL("storms.json", DIR), "utf8")) as { slug: string }[];
const RESOLUTIONS = ["4", "5"];
const MIN_AID = 250;
const MAX_AID = 2000;
const MEAN_AID = 1000;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("web map data", () => {
  it("has a file for each demo storm, small enough to load on stage", () => {
    expect(listing.map((s) => s.slug).sort()).toEqual(["helene-2024", "ian-2022", "katrina-2005"]);
    for (const { slug } of listing) {
      const file = new URL(`${slug}.json`, DIR);
      expect(existsSync(file), slug).toBe(true);
      expect(statSync(file).size, slug).toBeLessThan(2_000_000);
    }
  });

  for (const { slug } of listing) {
    const f = JSON.parse(readFileSync(new URL(`${slug}.json`, DIR), "utf8"));
    const p = f.projection;

    describe(slug, () => {
      it("projects a $1,000 average inside the $250-$2,000 band", () => {
        expect(p.eligibleHouseholds).toBeGreaterThan(100_000);
        expect(Math.abs(p.potUsd / p.eligibleHouseholds - MEAN_AID)).toBeLessThan(1);
        expect(p.minAidUsd).toBeGreaterThanOrEqual(MIN_AID);
        expect(p.maxAidUsd).toBeLessThanOrEqual(MAX_AID);
        expect(p.medianAidUsd).toBeGreaterThanOrEqual(p.minAidUsd);
        expect(p.medianAidUsd).toBeLessThanOrEqual(p.maxAidUsd);
        expect(Math.abs(sum(p.byHazard.map((g: { totalUsd: number }) => g.totalUsd)) - p.potUsd)).toBeLessThan(p.byHazard.length);
      });

      it("counties add up to the pot, and only declared counties get aid", () => {
        const c = f.counties as { aidUsd: number; eligible: number; declared: boolean }[];
        expect(Math.abs(sum(c.map((x) => x.aidUsd)) - p.potUsd)).toBeLessThanOrEqual(c.length / 2 + 1);
        expect(sum(c.map((x) => x.eligible))).toBe(p.eligibleHouseholds);
        expect(c.filter((x) => x.declared).length).toBe(p.declaredCounties);
        for (const x of c) if (x.aidUsd > 0) expect(x.declared).toBe(true);
        // Sorted biggest first: the rail's "Hardest hit" list takes the top rows as they are.
        for (let i = 1; i < c.length; i++) expect(c[i - 1]!.aidUsd).toBeGreaterThanOrEqual(c[i]!.aidUsd);
      });

      for (const res of RESOLUTIONS) {
        it(`res-${res} hexes add up to the pot with consistent columns`, () => {
          const h = f.hexes[res];
          const n = h.h3.length;
          expect(n).toBeGreaterThan(500);
          for (const [k, col] of Object.entries(h)) expect((col as unknown[]).length, k).toBe(n);
          expect(new Set(h.h3).size).toBe(n);
          for (const cell of h.h3) {
            expect(isValidCell(cell)).toBe(true);
            expect(getResolution(cell)).toBe(Number(res));
          }

          expect(Math.abs(sum(h.aid) - p.potUsd)).toBeLessThanOrEqual(n / 2 + 1);
          expect(sum(h.eligible)).toBe(p.eligibleHouseholds);

          for (let i = 0; i < n; i++) {
            expect(h.eligible[i]).toBeLessThanOrEqual(h.households[i]);
            if (h.aid[i] > 0) {
              // A hex averages tracts that are each inside the band, so its average is too.
              const per = h.aid[i] / h.eligible[i];
              expect(per).toBeGreaterThanOrEqual(MIN_AID - 0.5);
              expect(per).toBeLessThanOrEqual(MAX_AID + 0.5);
              expect(h.hazard[i]).toBeGreaterThan(0);
            } else expect(h.eligible[i]).toBe(0);
            // Wind thresholds are reached in order (-1 = never).
            if (h.t64[i] >= 0) expect(h.t50[i]).toBeGreaterThanOrEqual(0);
            if (h.t50[i] >= 0) expect(h.t34[i]).toBeGreaterThanOrEqual(0);
            if (h.t50[i] >= 0) expect(h.t50[i]).toBeGreaterThanOrEqual(h.t34[i]);
            if (h.t64[i] >= 0) expect(h.t64[i]).toBeGreaterThanOrEqual(h.t50[i]);
            expect(h.needPct[i]).toBeGreaterThanOrEqual(0);
            expect(h.needPct[i]).toBeLessThanOrEqual(100);
            expect(h.county[i]).toBeGreaterThanOrEqual(-1);
            expect(h.county[i]).toBeLessThan(f.counties.length);
            expect(h.hazard[i]).toBeLessThan(f.hazards.length);
          }
        });
      }

      it("has a track in time order and a focus area around the aid", () => {
        const pts = f.storm.points as { t: number }[];
        for (let i = 1; i < pts.length; i++) expect(pts[i]!.t).toBeGreaterThan(pts[i - 1]!.t);
        for (const lf of f.storm.landfalls as { t: number }[]) {
          expect(lf.t).toBeGreaterThanOrEqual(pts[0]!.t);
          expect(lf.t).toBeLessThanOrEqual(pts[pts.length - 1]!.t);
        }
        const [[w, s], [e, n]] = f.focus.bounds;
        expect(w).toBeLessThan(e);
        expect(s).toBeLessThan(n);
        expect(f.focus.rings.length).toBe(5);
        for (const ring of f.focus.rings as [number, number][][]) expect(ring[0]).toEqual(ring[ring.length - 1]);
      });
    });
  }
});
