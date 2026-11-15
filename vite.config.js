import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import fs from 'node:fs';
import path from 'node:path';

// Dev only: the browser POSTs rendered frames to /__shot, saved under shots/ so grading can be compared frame by frame. Not part of the build.
function shotSaver() {
  return {
    name: 'shot-saver',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const { name, data } = JSON.parse(body);
          const safe = String(name).replace(/[^\w.-]/g, '_');
          const dir = path.resolve(server.config.root, 'shots');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, safe), Buffer.from(data.split(',')[1], 'base64'));
          res.end('ok');
        });
      });
    },
  };
}

// src/data.js imports every binary and image with Vite's `?inline` suffix, which base64s the
// asset straight into the JS bundle however the build is configured. That is what the single-file
// build wants, and it is also what pushed the hosted bundle to 31 MB on its own -- over Pages'
// 25 MiB per-file cap even with the single-file plugin removed. For a hosted build this rewrites
// the query to `?url`, so the same imports emit ordinary files the page fetches at runtime.
function externaliseInlined() {
  return {
    name: 'externalise-inlined',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.includes('?inline')) return null;
      return this.resolve(source.replace('?inline', '?url'), importer, { skipSelf: true });
    },
  };
}

// The build defaults to a self-contained index.html: scripts, styles, fonts and terrain data
// all inlined, so it opens offline with a double click. That single file comes to about 37 MB,
// which Cloudflare Pages refuses -- it caps any one file at 25 MiB -- so a hosted build emits
// ordinary separate asset files instead. Largest asset is terrain_inner.bin at 4.6 MB, so
// nothing approaches the cap that way.
//
// The hosted mode is chosen automatically when Cloudflare runs the build (CF_PAGES is set for
// every Pages build), so the dashboard's build command can stay plain `npm run build` -- asking
// a dashboard field to carry `INLINE=0` is a setting that gets lost, and the failure it causes
// is a deploy that quietly ships the 37 MB file again.
//
// npm run build                 -> dist/index.html only, for handing round or opening offline
// INLINE=0 npm run build        -> dist/ with separate files, to reproduce a hosted build locally
const hosted = process.env.CF_PAGES === '1' || process.env.INLINE === '0';
const inline = !hosted;

export default defineConfig({
  base: './',
  assetsInclude: ['**/*.bin', '**/*.glb'],
  plugins: [inline ? null : externaliseInlined(), inline ? viteSingleFile() : null, shotSaver()].filter(Boolean),
  build: {
    target: 'es2022',
    assetsInlineLimit: inline ? () => true : undefined,
    chunkSizeWarningLimit: 40000,
  },
});
