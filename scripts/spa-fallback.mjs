/**
 * GitHub Pages serves static files only — there's no server to rewrite
 * unknown paths (like /fleet or /operator) back to index.html the way the
 * real Fastify server does. GitHub Pages' documented workaround is to also
 * publish a 404.html that's a copy of index.html: a direct hit on /operator
 * 404s, Pages serves 404.html, and the SPA's own router (App.tsx reading
 * window.location.pathname) takes it from there.
 *
 * Also drops a .nojekyll file so Pages doesn't run its default Jekyll
 * processing, which would otherwise ignore files/folders starting with "_".
 */
import fs from "node:fs";
import path from "node:path";

const distDir = process.argv[2];
if (!distDir) {
  console.error("usage: node scripts/spa-fallback.mjs <dist-dir>");
  process.exit(1);
}

const indexPath = path.join(distDir, "index.html");
const notFoundPath = path.join(distDir, "404.html");
fs.copyFileSync(indexPath, notFoundPath);
fs.writeFileSync(path.join(distDir, ".nojekyll"), "");
console.log(`Wrote ${notFoundPath} and .nojekyll for GitHub Pages SPA fallback.`);
