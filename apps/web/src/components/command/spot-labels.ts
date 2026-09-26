import type { Map as MLMap } from "maplibre-gl";
import { LABEL_MAX, type LabelTone, type SpotLabel } from "@/lib/live-effects";

/** Stem from the point up to the chip, px. */
const STEM = 16;
const GAP = 5;
const FADE_IN = 0.28;
const FADE_OUT = 0.6;
const RISE_PX = 8;
/** Keep chips below the top bar. */
const TOP_SAFE = 64;

const TONE: Record<LabelTone, { dot: string; border: string; stem: string; glow: string }> = {
  teal: {
    dot: "#2dd4bf",
    border: "rgba(45,212,191,0.34)",
    stem: "linear-gradient(to top, rgba(45,212,191,0), rgba(45,212,191,0.75))",
    glow: "0 0 0 1px rgba(45,212,191,0.06), 0 8px 24px -8px rgba(45,212,191,0.35), 0 10px 28px -12px rgba(0,0,0,0.7)",
  },
  red: {
    dot: "#f0616d",
    border: "rgba(240,97,109,0.45)",
    stem: "linear-gradient(to top, rgba(240,97,109,0), rgba(240,97,109,0.8))",
    glow: "0 0 0 1px rgba(240,97,109,0.08), 0 8px 24px -8px rgba(240,97,109,0.4), 0 10px 28px -12px rgba(0,0,0,0.7)",
  },
  amber: {
    dot: "#f5b83d",
    border: "rgba(245,184,61,0.4)",
    stem: "linear-gradient(to top, rgba(245,184,61,0), rgba(245,184,61,0.75))",
    glow: "0 0 0 1px rgba(245,184,61,0.06), 0 8px 24px -8px rgba(245,184,61,0.35), 0 10px 28px -12px rgba(0,0,0,0.7)",
  },
};

interface Slot {
  root: HTMLDivElement;
  chip: HTMLDivElement;
  stem: HTMLDivElement;
  dot: HTMLSpanElement;
  text: HTMLSpanElement;
  via: HTMLSpanElement;
  figure: HTMLSpanElement;
  sub: HTMLDivElement;
  id: number;
  w: number;
  h: number;
  /** Extra offset (px) to clear older labels, eased toward its target; null = just assigned. */
  lift: number | null;
  /** Hanging below the point (near the top edge). */
  below: boolean;
  shown: { transform: string; opacity: string; stem: string };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  parent?.appendChild(e);
  return e;
}

/**
 * The map's spotlight chips ("Maria G. · Bottled water x2 via Grok"): a fixed pool of DOM nodes
 * positioned with map.project from the frame loop. Text is written once per label; per frame
 * only transform/opacity change (and only when they do), so there is no React work at all.
 * Newer labels lift above older ones they would overlap.
 */
export class SpotLabels {
  private slots: Slot[] = [];

  private readonly stems: HTMLDivElement;
  private readonly chips: HTMLDivElement;

  constructor(container: HTMLElement) {
    // Stems live under every chip, so a tall stem never cuts through an older label.
    this.stems = el("div", "absolute inset-0", container);
    this.chips = el("div", "absolute inset-0", container);
    for (let i = 0; i < LABEL_MAX; i++) {
      const root = el("div", "absolute left-0 top-0", this.chips);
      root.style.opacity = "0";
      root.style.willChange = "transform, opacity";
      const stem = el("div", "absolute left-0 top-0 w-px", this.stems);
      stem.style.opacity = "0";
      stem.style.willChange = "transform, opacity";
      const chip = el(
        "div",
        "glass absolute bottom-0 left-0 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs leading-4 text-text",
        root,
      );
      const line = el("div", "flex items-center gap-2", chip);
      const dot = el("span", "size-1.5 shrink-0 rounded-full", line);
      const text = el("span", "font-medium", line);
      const via = el("span", "rounded border border-storm/20 bg-storm-soft px-1 text-[10px] font-medium leading-4 text-storm", line);
      const figure = el("span", "tabular text-text-2", line);
      const sub = el("div", "mt-0.5 pl-3.5 text-2xs", chip);
      this.slots.push({
        root,
        chip,
        stem,
        dot,
        text,
        via,
        figure,
        sub,
        id: -1,
        w: 0,
        h: 0,
        lift: null,
        below: false,
        shown: { transform: "", opacity: "0", stem: "" },
      });
    }
  }

  private assign(slot: Slot, l: SpotLabel) {
    const t = TONE[l.tone];
    slot.id = l.id;
    slot.lift = null;
    slot.chip.style.borderColor = t.border;
    slot.chip.style.boxShadow = t.glow;
    slot.stem.style.background = t.stem;
    slot.dot.style.background = t.dot;
    slot.dot.style.boxShadow = `0 0 8px ${t.dot}`;
    // "Maria G. · Bottled water x2 via Grok" -> the agent gets its own little tag.
    const m = /^(.*) via (Grok|an agent)$/.exec(l.text);
    slot.text.textContent = m ? m[1]! : l.text;
    slot.via.textContent = m ? (m[2] === "Grok" ? "via Grok" : "via agent") : "";
    slot.via.style.display = m ? "" : "none";
    slot.figure.textContent = l.figure ?? "";
    slot.figure.style.display = l.figure ? "" : "none";
    slot.figure.style.color = l.tone === "red" ? "rgba(240,97,109,0.85)" : l.tone === "teal" ? "#2dd4bf" : "";
    slot.figure.style.textDecoration = l.tone === "red" && l.figure ? "line-through" : "";
    slot.sub.textContent = l.sub ?? "";
    slot.sub.style.display = l.sub ? "" : "none";
    slot.sub.style.color = l.tone === "red" ? "#f0616d" : "#7c8aa0";
    // One layout read per new label, never per frame.
    slot.w = slot.chip.offsetWidth;
    slot.h = slot.chip.offsetHeight;
  }

  /** Called from the map's frame loop with the labels alive now. */
  frame(labels: SpotLabel[], map: MLMap, nowSec: number, dt: number, reduceMotion: boolean) {
    // Keep slots bound to the same label; free the rest.
    const live = new Set(labels.map((l) => l.id));
    for (const s of this.slots) if (s.id >= 0 && !live.has(s.id)) s.id = -1;
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const canvas = map.getContainer();
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    for (const l of labels) {
      let slot = this.slots.find((s) => s.id === l.id);
      if (!slot) {
        slot = this.slots.find((s) => s.id < 0);
        if (!slot) continue;
        this.assign(slot, l);
      }
      const p = map.project([l.lon, l.lat]);
      const age = nowSec - l.born;
      const left = l.life - age;
      let opacity = reduceMotion ? 1 : Math.min(1, age / FADE_IN) * Math.min(1, left / FADE_OUT);
      if (p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40) opacity = 0;

      // Lift above older labels this one would overlap; near the top edge, hang below the point instead.
      let target = 0;
      let below = false;
      for (let i = 0; i < 6; i++) {
        const y1 = p.y - STEM - target;
        const r = { x0: p.x - slot.w / 2, x1: p.x + slot.w / 2, y0: y1 - slot.h, y1 };
        if (r.y0 < TOP_SAFE) {
          below = true;
          break;
        }
        const hit = placed.find((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
        if (!hit) break;
        target += r.y1 - hit.y0 + GAP;
      }
      if (below) {
        target = 0;
        for (let i = 0; i < 6; i++) {
          const y0 = p.y + STEM + target;
          const r = { x0: p.x - slot.w / 2, x1: p.x + slot.w / 2, y0, y1: y0 + slot.h };
          const hit = placed.find((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
          if (!hit) break;
          target += hit.y1 - r.y0 + GAP;
        }
        target = -target;
      }
      slot.lift = reduceMotion || slot.lift === null || slot.below !== below ? target : slot.lift + (target - slot.lift) * Math.min(1, dt * 10);
      slot.below = below;
      const stemLen = STEM + Math.abs(slot.lift);
      const chipY = below ? stemLen : -stemLen - slot.h;
      placed.push({ x0: p.x - slot.w / 2, x1: p.x + slot.w / 2, y0: p.y + chipY, y1: p.y + chipY + slot.h });

      const rise = reduceMotion ? 0 : (1 - Math.min(1, age / 0.45)) ** 3 * RISE_PX;
      const transform = `translate3d(${p.x.toFixed(1)}px, ${(p.y + rise).toFixed(1)}px, 0)`;
      const op = opacity.toFixed(3);
      const stem = `${below ? "b" : "a"}${stemLen.toFixed(1)}`;
      if (slot.shown.stem !== stem) {
        slot.stem.style.height = `${stemLen.toFixed(1)}px`;
        slot.chip.style.transform = `translate(-50%, ${(chipY + slot.h).toFixed(1)}px)`;
        slot.shown.stem = stem;
        slot.shown.transform = "";
      }
      if (slot.shown.transform !== transform) {
        slot.root.style.transform = transform;
        // The stem runs from the point to the chip: up normally, down when hanging below.
        const sy = p.y + rise - (below ? 0 : stemLen);
        const sx = p.x - 0.5;
        slot.stem.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)${below ? " scaleY(-1)" : ""}`;
        slot.shown.transform = transform;
      }
      if (slot.shown.opacity !== op) {
        slot.root.style.opacity = op;
        slot.stem.style.opacity = op;
        slot.shown.opacity = op;
      }
    }
    for (const s of this.slots) {
      if (s.id < 0 && s.shown.opacity !== "0") {
        s.root.style.opacity = "0";
        s.stem.style.opacity = "0";
        s.shown.opacity = "0";
      }
    }
  }

  destroy() {
    this.stems.remove();
    this.chips.remove();
    this.slots = [];
  }

  clear() {
    for (const s of this.slots) {
      s.id = -1;
      s.root.style.opacity = "0";
      s.stem.style.opacity = "0";
      s.shown.opacity = "0";
    }
  }
}
