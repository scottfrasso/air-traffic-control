import { Composition } from "remotion";
import { SHORT_END } from "./short-timeline";
import { Short } from "./Short";
import { FPS, T } from "./timeline";
import { Video } from "./Video";

export function Root() {
  return (
    <>
      <Composition id="ATC" component={Video} durationInFrames={Math.ceil(T.end * FPS)} fps={FPS} width={1920} height={1080} />
      <Composition id="ATCShort" component={Short} durationInFrames={Math.ceil(SHORT_END * FPS)} fps={FPS} width={1920} height={1080} />
    </>
  );
}
