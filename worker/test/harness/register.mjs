// Lets Durable Objects and Workflows run in plain Node for tests: "cloudflare:workers" resolves to a small stand-in.
import { register } from "node:module";
register("./loader.mjs", import.meta.url);
