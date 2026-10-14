/** ATCShort: the ~60-second LinkedIn cut (about 65 s in the Scott voice), with burned-in captions (LinkedIn autoplays muted). */
import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Board, fade, PointBadge } from "./scene/Overlay";
import { C, PIXEL, TERM } from "./scene/Stage";
import { caption, longTime, SEGMENTS, shortVoFile, type ShortSegment } from "./short-timeline";
import run from "./data/run.json";
import { FPS, PAIRS } from "./timeline";
import { Beat } from "./Video";

const N = run.order.length;
const NUMBERS = [
  [String(N), "changes in flight at once"],
  [String(PAIRS.length), "pairs test-merged and type-checked"],
  [String(PAIRS.filter((p) => p.status === "semantic_conflict").length), "real conflict, caught before anyone asked to merge"],
  [String(run.rebased.length), `rebases (rebasing on every merge: ${(N * (N - 1)) / 2})`],
] as const;

// A real flight log, trimmed to the lines that tell the story. It is from the public replay run (shop-261011185716),
// not the run on the other cards (run.json predates flight logs), and that run had a go-around: the title says so.
const NOTE = [
  "ATC-PR: PR2",
  "ATC-Signal: semantic_conflict with PR1 on applyDiscount",
  "ATC-Clearance: HOLD (Lands after PR1, then rebase.)",
  "ATC-Clearance: GO AROUND (Rebase onto main and fix.)",
  "ATC-Clearance: CLEARED (Cleared to land. No conflicts.)",
  "ATC-Landed-Onto: 5c6add5b501d",
];

function Card({ seg, t }: { seg: ShortSegment; t: number }) {
  if (seg.card === "numbers")
    return (
      <Board t={t} from={seg.start} title="ONE RECORDED RUN">
        <div style={{ position: "absolute", left: 160, top: 210, display: "flex", flexDirection: "column", gap: 34 }}>
          {NUMBERS.map(([n, label], i) => {
            const k = fade(t, seg.voAt + i * 1.6, 0.4);
            return (
              <div key={label} style={{ display: "flex", alignItems: "baseline", gap: 40, opacity: k, transform: `translateX(${(1 - k) * -40}px)` }}>
                <span style={{ font: `96px/1 ${PIXEL}`, color: i === 3 ? C.green : C.orange, width: 200, textAlign: "right" }}>{n}</span>
                <span style={{ font: `54px/1.1 ${TERM}`, color: C.text }}>{label}</span>
              </div>
            );
          })}
        </div>
      </Board>
    );
  return (
    <Board t={t} from={seg.start} title="FLIGHT LOG (A GIT NOTE) FROM ANOTHER RUN">
      <div style={{ position: "absolute", left: 160, top: 200, width: 1600, padding: "34px 44px", background: C.panel, border: `6px solid ${C.cyan}`, boxShadow: "10px 10px 0 #000" }}>
        <div style={{ font: `34px/1.2 ${TERM}`, color: C.dim, marginBottom: 18 }}>$ git log --notes=atc</div>
        {NOTE.map((l, i) => (
          <div key={l} style={{ font: `40px/1.35 ${TERM}`, color: l.includes("GO AROUND") ? C.amber : l.includes("CLEARED") ? C.green : C.text, opacity: fade(t, seg.voAt + i * 0.5, 0.3) }}>{l}</div>
        ))}
      </div>
    </Board>
  );
}

function Captions({ t }: { t: number }) {
  const seg = SEGMENTS.find((s) => t >= s.start && t < s.end);
  const text = seg && caption(seg, t);
  if (!text) return null;
  return (
    // A full-width band, so it also covers the long video's own on-screen captions underneath.
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 140, display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0e22", borderTop: `5px solid ${C.orange}` }}>
      <div style={{ maxWidth: 1720, font: `52px/1.08 ${TERM}`, color: "#fff", textAlign: "center" }}>{text}</div>
    </div>
  );
}

export function Short() {
  const t = useCurrentFrame() / FPS;
  const seg = SEGMENTS.find((s) => t >= s.start && t < s.end) ?? SEGMENTS[SEGMENTS.length - 1]!;
  const lt = longTime(seg, t);
  return (
    <AbsoluteFill style={{ background: C.night }}>
      {lt === null ? <Card seg={seg} t={t} /> : <Beat t={lt} />}
      {lt !== null && (seg.id === "run" || seg.id === "order") && <PointBadge t={lt} />}
      <Captions t={t} />
      {SEGMENTS.map((s) => (
        <Sequence key={s.id} from={Math.round(s.voAt * FPS)} layout="none">
          <Audio src={staticFile(shortVoFile(s.id))} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
