import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Airport } from "./beats/Airport";
import { Chaos } from "./beats/Chaos";
import { RealRun } from "./beats/RealRun";
import { Today } from "./beats/Today";
import { FPS, T, VO, voFile } from "./timeline";

export function Video() {
  const t = useCurrentFrame() / FPS;
  return (
    <AbsoluteFill>
      {t < T.setupStart ? <Chaos t={t} /> : t < T.rewindEnd ? <Today t={t} /> : t < T.b5 ? <RealRun t={t} /> : <Airport t={t} />}
      {VO.map((v) => (
        <Sequence key={v.id} from={Math.round(v.at * FPS)} layout="none">
          <Audio src={staticFile(voFile(v.id))} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
