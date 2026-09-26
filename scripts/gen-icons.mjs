// Rasterize assets/icon.svg into the extension icon PNGs. Run with `pnpm icons`.
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'assets/icon.svg'), 'utf8');
const outDir = join(root, 'public/icon');
mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 96, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(join(outDir, `${size}.png`), png);
  console.log(`icon/${size}.png  ${png.length} bytes`);
}
