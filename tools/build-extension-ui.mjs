import { build } from 'esbuild';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'extension', 'dist');

mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  logLevel: 'info',
  minify: true,
  sourcemap: false,
  target: ['chrome120'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
};

await Promise.all([
  build({
    ...common,
    entryPoints: [resolve(root, 'extension', 'src', 'popup.jsx')],
    outfile: resolve(outdir, 'popup.js'),
  }),
  build({
    ...common,
    entryPoints: [resolve(root, 'extension', 'src', 'options.jsx')],
    outfile: resolve(outdir, 'options.js'),
  }),
]);
