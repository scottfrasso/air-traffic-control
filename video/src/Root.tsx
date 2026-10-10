import { Composition } from "remotion";
import { FPS, T } from "./timeline";
import { Video } from "./Video";

export function Root() {
  return <Composition id="ATC" component={Video} durationInFrames={Math.ceil(T.end * FPS)} fps={FPS} width={1920} height={1080} />;
}
