export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: new URL("./cloudflare-workers.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}

// Wrangler imports .html as text (the Worker's static shells); do the same in Node tests.
export async function load(url, context, next) {
  if (url.endsWith(".html")) {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(new URL(url), "utf8");
    return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  return next(url, context);
}
