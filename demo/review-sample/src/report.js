import { readFileSync } from "node:fs";

/** How many log lines mention `word` (case-sensitive). */
export function countMentions(logFile, word) {
  return readFileSync(logFile, "utf8").split("\n").filter((line) => line.includes(word)).length;
}
