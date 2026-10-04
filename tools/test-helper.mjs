/**
 * Helper dos testes: empacota um entry TS (com imports `?raw`) para JS e executa-o
 * em Node com globals de browser (jsdom) quando necessário.
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const rawPlugin = {
  name: "raw",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => {
      const rel = args.path.replace(/\?raw$/, "");
      const abs = path.isAbsolute(rel) ? rel : path.join(args.resolveDir, rel);
      return { path: abs, namespace: "raw" };
    });
    b.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => {
      const fs = await import("node:fs/promises");
      const p = path.isAbsolute(args.path) ? args.path : path.join(args.resolveDir, args.path);
      return { contents: await fs.readFile(p, "utf8"), loader: "text" };
    });
  },
};

export async function bundleTs(entry, outfile) {
  const out = path.isAbsolute(outfile) ? outfile : path.join(root, outfile);
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    outfile: out,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    jsx: "automatic",
    loader: { ".txt": "text", ".css": "empty" },
    plugins: [rawPlugin],
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "sonner", "lucide-react", "@radix-ui/*", "@ffmpeg/*"],
    logLevel: "silent",
  });
  return out;
}

let failures = 0;
export function check(name, cond, extra = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}
export function section(t) {
  console.log(`\n— ${t}`);
}
export function finish() {
  if (failures > 0) {
    console.error(`\n${failures} verificação(ões) falharam.`);
    process.exit(1);
  }
  console.log("\nTudo verde ✔");
}

/** Globals mínimas de browser (localStorage, document, window) via jsdom. */
export async function setupDom() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost:5173/",
    pretendToBeVisual: true,
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.XMLHttpRequest = dom.window.XMLHttpRequest;
  // Node ≥ 18 já traz FormData/Blob/File/fetch nativos e completos (arrayBuffer, etc.).
  // Só usamos os do jsdom como recurso.
  globalThis.FormData = globalThis.FormData || dom.window.FormData;
  globalThis.Blob = globalThis.Blob || dom.window.Blob;
  globalThis.File = globalThis.File || dom.window.File;
  globalThis.fetch = globalThis.fetch || dom.window.fetch;
  return dom;
}
