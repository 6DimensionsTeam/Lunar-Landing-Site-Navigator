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

// The build is a self-contained index.html: scripts, styles, fonts and terrain data all inlined, so it opens offline with a double click.
export default defineConfig({
  base: './',
  assetsInclude: ['**/*.bin', '**/*.glb'],
  plugins: [viteSingleFile(), shotSaver()],
  build: {
    target: 'es2022',
    assetsInlineLimit: () => true,
    chunkSizeWarningLimit: 40000,
  },
});
