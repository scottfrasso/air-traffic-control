import type { VoiceKey } from "./script";

/** Where each voice's clips and manifest live. Matilda's long cut keeps its original paths (vo/, vo.json). */
export function voPaths(voice: VoiceKey, short: boolean): { dir: string; manifest: string } {
  if (!short && voice === "matilda") return { dir: "vo", manifest: "vo.json" };
  return { dir: `vo/${short ? "short/" : ""}${voice}`, manifest: `vo.${short ? "short." : ""}${voice}.json` };
}
