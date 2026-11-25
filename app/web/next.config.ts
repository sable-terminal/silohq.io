// The web client is a static export served by the cell's gateway at its public origin, beside
// the API under /api/v1: no server of its own, the same files hosted and self-managed. Pages
// render in the browser; an object's id travels in the query string, since a static export
// has no page for an id it did not know at build time.

import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// MapLibre's worker (the base map, D227), served from this origin beside the pages: the bundle
// would otherwise look for it next to its own chunk. Copied on every build, so it is the
// installed version's.
const maplibre = path.join(import.meta.dirname, 'node_modules', 'maplibre-gl', 'dist');
mkdirSync(path.join(import.meta.dirname, 'public', 'maplibre'), { recursive: true });
copyFileSync(path.join(maplibre, 'maplibre-gl-worker.mjs'), path.join(import.meta.dirname, 'public', 'maplibre', 'maplibre-gl-worker.mjs'));
// three.js's decoders for compressed models and textures (the 3D asset view, D228): Draco's glTF
// build and the Basis Universal transcoder, fetched by their loaders from this origin.
const threeLibs = path.join(import.meta.dirname, 'node_modules', 'three', 'examples', 'jsm', 'libs');
for (const [from, to, files] of [
  ['draco/gltf', 'draco', ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']],
  ['basis', 'basis', ['basis_transcoder.js', 'basis_transcoder.wasm']],
] as const) {
  mkdirSync(path.join(import.meta.dirname, 'public', 'three', to), { recursive: true });
  for (const file of files) copyFileSync(path.join(threeLibs, from, file), path.join(import.meta.dirname, 'public', 'three', to, file));
}

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  // Type checking is `npm run typecheck` (TypeScript 7, the server's), not the build's.
  typescript: { ignoreBuildErrors: true },
  // The repository's app/ directory: the canvas lays out with the server's own layout engine
  // (app/server/src/services/canvas-layout/layoutEngine.service.ts, pure and import-free), so a
  // set is drawn the same whether the client or the render service placed it (spec 29.8).
  turbopack: { root: path.resolve(import.meta.dirname, '..') },
  outputFileTracingRoot: path.resolve(import.meta.dirname, '..'),
};

export default config;
