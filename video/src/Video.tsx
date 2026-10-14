import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Agents } from "./beats/Agents";
import { Airport } from "./beats/Airport";
import { Chaos } from "./beats/Chaos";
import { Idea } from "./beats/Idea";
import { Opening } from "./beats/Opening";
import { Problem } from "./beats/Problem";
import { RealRun } from "./beats/RealRun";
import { Recap } from "./beats/Recap";
import { Today } from "./beats/Today";
import { PointBadge, SectionStrip } from "./scene/Overlay";
import { FPS, T, VO, voFile } from "./timeline";

/** v8: say what you'll show (Opening), show it (Problem → Idea → Chaos/Today → RealRun → Agents → Airport), recap it. */
export function Beat({ t }: { t: number }) {
  if (t < T.p1End) return <Opening t={t} />;
  if (t < T.probEnd) return <Problem t={t} />;
  if (t < T.ideaEnd) return <Idea t={t} />;
  if (t < T.setupStart) return <Chaos t={t} />;
  if (t < T.rewindEnd) return <Today t={t} />;
  if (t < T.b4End) return <RealRun t={t} />;
  if (t < T.agentsEnd) return <Agents t={t} />;
  if (t < T.recapStart) return <Airport t={t} />;
  return <Recap t={t} />;
}

export function Video() {
  const t = useCurrentFrame() / FPS;
  return (
    <AbsoluteFill>
      <Beat t={t} />
      <SectionStrip t={t} />
      <PointBadge t={t} />
      {VO.map((v) => (
        <Sequence key={v.id} from={Math.round(v.at * FPS)} layout="none">
          <Audio src={staticFile(voFile(v.id))} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
