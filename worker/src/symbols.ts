/**
 * Lightweight TypeScript surface extraction: exported declarations (with a normalized
 * signature) and named imports. Deliberately regex/scan based rather than the TypeScript
 * compiler, which is too large for a Worker bundle (see ADR-0007). Typecheck in the
 * Sandbox is the source of truth; this only powers early, informational signals.
 */

export type SymbolKind = "function" | "const" | "class" | "interface" | "type" | "enum";

export interface ExportedSymbol {
  name: string;
  kind: SymbolKind;
  /** Normalized signature: params + return type for functions, declared type otherwise. */
  signature: string;
  /** Normalized full declaration text, used to detect body-only changes. */
  body: string;
}

export interface ImportedName {
  /** Name as exported by the source module. */
  name: string;
  /** Module specifier as written, e.g. "./pricing". */
  from: string;
}

const norm = (s: string) => s.replace(/\s+/g, " ").replace(/\s*([(),:<>=|&{};[\]])\s*/g, "$1").trim();

/** Index of the bracket matching the opener at `start` (handles (), <>, {}, [] and strings). */
function matchBracket(src: string, start: number): number {
  const open = src[start];
  const close = open === "(" ? ")" : open === "<" ? ">" : open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close && !(close === ">" && src[i - 1] === "=")) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length - 1;
}

/** End of a top-level declaration starting at `start`: the next line that begins a new top-level statement. */
function declarationEnd(src: string, start: number): number {
  const re = /\n(?=export\s|import\s|function\s|const\s|let\s|class\s|interface\s|type\s|enum\s|\/\/|\/\*)/g;
  re.lastIndex = start + 1;
  const m = re.exec(src);
  return m ? m.index : src.length;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

export function extractExports(source: string): ExportedSymbol[] {
  const src = stripComments(source);
  const out: ExportedSymbol[] = [];
  const re = /^export\s+(?:default\s+)?(?:declare\s+)?(async\s+)?(function\*?|const|let|var|abstract\s+class|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const keyword = (m[2] ?? "").replace(/\s+/g, " ");
    const name = m[3] ?? "";
    const after = m.index + m[0].length;
    const end = declarationEnd(src, m.index);
    const body = norm(src.slice(m.index, end));
    let kind: SymbolKind;
    let signature: string;
    if (keyword.startsWith("function")) {
      kind = "function";
      let i = after;
      let generics = "";
      if (src[i] === "<") {
        const g = matchBracket(src, i);
        generics = src.slice(i, g + 1);
        i = g + 1;
      }
      const p0 = src.indexOf("(", i);
      const p1 = matchBracket(src, p0);
      const brace = src.indexOf("{", p1);
      const ret = src.slice(p1 + 1, brace < 0 || brace > end ? end : brace).replace(/^\s*:/, "").replace(/;\s*$/, "");
      signature = norm(`${generics}${src.slice(p0, p1 + 1)}${ret.trim() ? `: ${ret}` : ""}`);
    } else if (keyword === "const" || keyword === "let" || keyword === "var") {
      kind = "const";
      const decl = src.slice(after, end);
      const typed = /^\s*:\s*([^=]+)=/.exec(decl);
      const arrow = /=\s*(async\s*)?(\([^)]*\)\s*(:\s*[^=]+)?=>)/.exec(decl);
      signature = norm(typed?.[1] ?? arrow?.[2] ?? "const");
    } else if (keyword.endsWith("class")) {
      kind = "class";
      signature = body;
    } else if (keyword === "interface" || keyword === "type" || keyword === "enum") {
      kind = keyword;
      signature = body;
    } else continue;
    out.push({ name, kind, signature, body });
  }
  // `export { a, b as c }` re-exports: record names with an opaque signature.
  const reExport = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;
  for (let m = reExport.exec(src); m; m = reExport.exec(src)) {
    for (const part of (m[1] ?? "").split(",")) {
      const alias = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, "");
      if (alias) out.push({ name: alias, kind: "const", signature: norm(m[0]), body: norm(m[0]) });
    }
  }
  return out;
}

export function extractImports(source: string): ImportedName[] {
  const src = stripComments(source);
  const out: ImportedName[] = [];
  const re = /^import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const from = m[3] ?? "";
    if (m[1]) out.push({ name: "default", from });
    for (const part of (m[2] ?? "").split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
      if (name) out.push({ name, from });
    }
  }
  return out;
}

/** Resolve a relative import specifier from `fromFile` to a repo path ("src/pricing.ts"), or null for packages. */
export function resolveImport(fromFile: string, spec: string, exists: (path: string) => boolean): string | null {
  if (!spec.startsWith(".")) return null;
  const dir = fromFile.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") dir.pop();
    else dir.push(seg);
  }
  const base = dir.join("/").replace(/\.(js|mjs|cjs)$/, "");
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (exists(candidate)) return candidate;
  return `${base}.ts`;
}

export type SymbolChange = "added" | "removed" | "signature_changed" | "body_changed";

export interface SymbolDelta {
  name: string;
  kind: SymbolKind;
  change: SymbolChange;
  before: string | null;
  after: string | null;
}

export function diffExports(before: ExportedSymbol[], after: ExportedSymbol[]): SymbolDelta[] {
  const b = new Map(before.map((s) => [s.name, s]));
  const a = new Map(after.map((s) => [s.name, s]));
  const out: SymbolDelta[] = [];
  for (const [name, s] of a) {
    const old = b.get(name);
    if (!old) out.push({ name, kind: s.kind, change: "added", before: null, after: s.signature });
    else if (old.signature !== s.signature) out.push({ name, kind: s.kind, change: "signature_changed", before: old.signature, after: s.signature });
    else if (old.body !== s.body) out.push({ name, kind: s.kind, change: "body_changed", before: old.signature, after: s.signature });
  }
  for (const [name, s] of b) if (!a.has(name)) out.push({ name, kind: s.kind, change: "removed", before: s.signature, after: null });
  return out;
}

/** Approximate changed-line count (multiset symmetric difference). Used only to rank rebase cost. */
export function changedLines(before: string, after: string): number {
  const count = new Map<string, number>();
  for (const l of before.split("\n")) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of after.split("\n")) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return added + removed;
}
