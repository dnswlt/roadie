// Frontend build. Run as `node build.mjs [--watch]`.
//
// Assets are content-hashed into dist/assets, and dist/index.html is generated
// from index.html with the hashed names substituted in. That pairing is why
// this is a script rather than an esbuild CLI invocation: the names change on
// every rebuild, so whatever writes them has to run afterwards, in watch mode
// too.

import esbuild from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

const OUT = "dist";
const ASSETS = `${OUT}/assets`;
const watch = process.argv.includes("--watch");

// index.html names its assets with these placeholders; the build fills them in.
const JS_SLOT = "{{APP_JS}}";
const CSS_SLOT = "{{APP_CSS}}";
const FAVICON_SLOT = "{{FAVICON}}";

// clean empties dist but keeps .gitkeep, which web/embed.go needs in order to
// compile when no build has run yet.
async function clean() {
  await mkdir(OUT, { recursive: true });
  for (const name of await readdir(OUT)) {
    if (name !== ".gitkeep") await rm(`${OUT}/${name}`, { recursive: true, force: true });
  }
}

// emitFavicon hashes favicon.svg into dist/assets by hand. Nothing imports it,
// so it is not in esbuild's graph and would otherwise be the one static asset
// served uncached — on every page load, twice (index.html references it from
// both <link rel=icon> and the topbar logo).
async function emitFavicon() {
  const bytes = await readFile("favicon.svg");
  const hash = createHash("sha256").update(bytes).digest("base64url").slice(0, 8);
  const name = `favicon-${hash}.svg`;
  await writeFile(`${ASSETS}/${name}`, bytes);
  return name;
}

// writeIndex rewrites dist/index.html for the outputs esbuild just produced.
// Stale hashed files are gone (clean ran first), so a name that survives here
// is one that exists.
async function writeIndex(metafile, favicon) {
  const url = (ext) => {
    const out = Object.keys(metafile.outputs).find((p) => p.endsWith(ext) && !p.endsWith(".map"));
    if (!out) throw new Error(`build produced no ${ext} output`);
    return `/${out.slice(OUT.length + 1)}`; // dist/assets/app-X.js -> /assets/app-X.js
  };
  const html = await readFile("index.html", "utf8");
  for (const slot of [JS_SLOT, CSS_SLOT, FAVICON_SLOT]) {
    if (!html.includes(slot)) throw new Error(`index.html must contain ${slot}`);
  }
  await writeFile(
    `${OUT}/index.html`,
    html
      .replaceAll(JS_SLOT, url(".js"))
      .replaceAll(CSS_SLOT, url(".css"))
      .replaceAll(FAVICON_SLOT, `/assets/${favicon}`),
  );
}

// prune drops assets from previous builds. Every rebuild writes new hashed
// names, so without this a watch session fills dist with bundles that go:embed
// would happily ship.
async function prune(metafile, favicon) {
  const current = new Set(Object.keys(metafile.outputs).map((p) => p.slice(ASSETS.length + 1)));
  current.add(favicon); // not an esbuild output, but not stale either
  for (const name of await readdir(ASSETS)) {
    if (!current.has(name)) await rm(`${ASSETS}/${name}`, { force: true });
  }
}

const emitIndex = {
  name: "emit-index",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return; // keep the last good dist on a failed rebuild
      const favicon = await emitFavicon();
      await writeIndex(result.metafile, favicon);
      await prune(result.metafile, favicon);
      if (watch) console.log(`[${new Date().toLocaleTimeString()}] rebuilt`);
    });
  },
};

const options = {
  entryPoints: ["src/app.ts"],
  bundle: true,
  outdir: ASSETS,
  entryNames: "[name]-[hash]",
  assetNames: "[name]-[hash]",
  // The webfont styles.css @font-faces: copied into dist/assets under a hashed
  // name, like every other asset, so it is served immutable.
  loader: { ".woff2": "file" },
  sourcemap: true,
  metafile: true,
  plugins: [emitIndex],
};

await clean();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
