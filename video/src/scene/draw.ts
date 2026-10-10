/** Pixel drawing, ported from the dashboard's canvas renderer and made a pure function of the scene. */
import { CHECK, GROUND, H, HANGARS, RUNWAY, TOWER, W, type Plane, type Pt } from "./geometry";

export interface Scene {
  t: number; // seconds, drives clouds and blinking
  planes: Plane[];
  conflict?: [string, string]; // red dotted link between two planes
  beams?: Array<{ from: Pt; to: Pt; color: string; progress?: number }>;
  checkLight?: string; // colour of the check light (the Sandbox)
  towerLight?: string;
  blink?: string[]; // plane ids with a blinking red box
}

type Ctx = CanvasRenderingContext2D;
let ctx: Ctx;
const px = (x: number, y: number, w: number, h: number, c: string) => {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
};

function sky() {
  const bands = ["#2a63c0", "#3471cc", "#3f80d8", "#4b8fe2", "#5a9dea", "#6cabf0", "#80baf4", "#96c8f7", "#aed6fa", "#c6e3fc"];
  const bh = Math.ceil(GROUND / bands.length);
  bands.forEach((c, i) => {
    px(0, i * bh, W, bh, c);
    const next = bands[i + 1];
    if (next) for (let x = (i % 2) * 2; x < W; x += 4) px(x, (i + 1) * bh - 1, 2, 1, next);
  });
}

function cloud(x: number, y: number, s: number, a: number) {
  ctx.globalAlpha = a;
  px(x + 6 * s, y, 10 * s, 3 * s, "#ffffff");
  px(x + 2 * s, y + 3 * s, 20 * s, 4 * s, "#ffffff");
  px(x, y + 6 * s, 26 * s, 3 * s, "#ffffff");
  px(x + 2 * s, y + 9 * s, 22 * s, 1 * s, "#d5e4f6");
  ctx.globalAlpha = 1;
}

const CLOUDS = [
  ...Array.from({ length: 5 }, (_, i) => ({ x: (i * 101) % W, y: 22 + ((i * 37) % 80), s: 2, v: 3, a: 0.95 })),
  ...Array.from({ length: 5 }, (_, i) => ({ x: (i * 89 + 40) % W, y: 104 + ((i * 23) % 70), s: 1, v: 1.5, a: 0.7 })),
];
function clouds(t: number) {
  for (const c of CLOUDS) {
    const span = W + 28 * c.s + 6;
    const x = ((((c.x - c.v * t) % span) + span) % span) - 28 * c.s;
    cloud(x, c.y, c.s, c.a);
  }
  cloud(W - 92, 6, 3, 1); // hero cloud, top right: reserved for the Cloudflare logo
}

function ground(s: Scene) {
  px(0, GROUND - 6, W, 6, "#6a9a5a");
  for (let x = 0; x < W; x += 24) px(x + 4, GROUND - 9, 14, 3, "#6a9a5a");
  px(0, GROUND, W, H - GROUND, "#3f7d36");
  for (let x = 0; x < W; x += 6) px(x, GROUND + 30, 3, 2, "#357030");
  // Hangars (each agent's fork).
  for (const hx of HANGARS) {
    px(hx, GROUND - 22, 44, 22, "#9aa3b5");
    px(hx + 2, GROUND - 25, 40, 3, "#9aa3b5");
    px(hx + 6, GROUND - 27, 32, 2, "#9aa3b5");
    px(hx + 6, GROUND - 16, 32, 16, "#2b3a5c");
    for (let y = GROUND - 14; y < GROUND; y += 3) px(hx + 6, y, 32, 1, "#3a4a70");
    px(hx, GROUND - 22, 44, 1, "#c7ccd8");
  }
  // Terminal + tower (the Durable Object).
  px(230, GROUND - 10, 70, 10, "#c7ccd8");
  for (let x = 234; x < 296; x += 6) px(x, GROUND - 7, 3, 3, "#2b3a5c");
  px(TOWER.x - 4, TOWER.top + 8, 8, GROUND - TOWER.top - 8, "#c7ccd8");
  px(TOWER.x - 8, TOWER.top + 1, 16, 7, "#78d7ff");
  px(TOWER.x - 9, TOWER.top - 1, 18, 2, "#2b3a5c");
  px(TOWER.x - 1, TOWER.top - 4, 2, 3, "#2b3a5c");
  if (s.towerLight) px(TOWER.x - 2, TOWER.top - 7, 4, 3, s.towerLight);
  // Check shed with its light (the Sandbox).
  px(CHECK.x - 7, CHECK.y, 14, GROUND - CHECK.y, "#7d8597");
  px(CHECK.x - 8, CHECK.y - 1, 16, 2, "#2b3a5c");
  const light = s.checkLight ?? "#4a5266";
  px(CHECK.x - 4, CHECK.y - 7, 8, 6, light);
  if (s.checkLight) {
    ctx.globalAlpha = 0.35;
    px(CHECK.x - 7, CHECK.y - 10, 14, 12, light);
    ctx.globalAlpha = 1;
  }
  // Apron + runway.
  px(196, GROUND + 6, RUNWAY.x - 192, 12, "#5a606c");
  px(RUNWAY.x, RUNWAY.y, RUNWAY.w, 8, "#4a4f5a");
  for (let i = 0; i < 3; i++) px(RUNWAY.x + 2, RUNWAY.y + 1 + i * 2, 6, 1, "#f4f4f4");
  for (let x = RUNWAY.x + 14; x < RUNWAY.x + RUNWAY.w - 4; x += 12) px(x, RUNWAY.y + 4, 6, 1, "#f4f4f4");
  const k = Math.floor(s.t * 9) % 6;
  for (let i = 0; i < 6; i++) px(RUNWAY.x - 6 - i * 7, GROUND + 3, 2, 2, i === 5 - k ? "#ffffff" : "#d8a72a");
}

function plane(p: Plane) {
  ctx.save();
  ctx.translate(Math.round(p.x), Math.round(p.y));
  if (p.face < 0) ctx.scale(-1, 1);
  const L = p.livery;
  px(-12, -5, 4, 5, L);
  px(-12, -1, 22, 4, "#f4f6fb");
  px(10, 0, 2, 2, "#f4f6fb");
  px(-12, 2, 22, 1, L);
  for (let x = -7; x < 8; x += 2) px(x, 0, 1, 1, "#24304f");
  px(8, 0, 2, 1, "#24304f");
  px(-3, 3, 7, 2, "#9aa3b5");
  ctx.restore();
}

function dotted(a: Pt, b: Pt, color: string, progress = 1) {
  ctx.fillStyle = color;
  const n = Math.max(1, Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3));
  for (let i = 0; i < n * progress; i += 2) ctx.fillRect(Math.round(a[0] + ((b[0] - a[0]) * i) / n), Math.round(a[1] + ((b[1] - a[1]) * i) / n), 2, 2);
}

export function drawScene(c: Ctx, s: Scene) {
  ctx = c;
  ctx.imageSmoothingEnabled = false;
  sky();
  clouds(s.t);
  ground(s);
  for (const b of s.beams ?? []) dotted(b.from, b.to, b.color, b.progress);
  const byId = new Map(s.planes.map((p) => [p.id, p]));
  if (s.conflict) {
    const a = byId.get(s.conflict[0]), b = byId.get(s.conflict[1]);
    if (a && b) dotted([a.x, a.y], [b.x, b.y], "#ff5757");
  }
  for (const p of s.planes) {
    plane(p);
    if (s.blink?.includes(p.id) && Math.floor(s.t * 3.3) % 2 === 0) {
      ctx.strokeStyle = "#ff5757";
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(p.x) - 15.5, Math.round(p.y) - 8.5, 31, 15);
    }
  }
}
