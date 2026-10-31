import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');

/** Files served as-is next to the compiled modules. */
const STATIC_FILES = ['index.html', 'app.css', 'editor.css', 'car-donors.json'];

mkdirSync(out, { recursive: true });
for (const file of STATIC_FILES) {
  copyFileSync(join(root, file), join(out, file));
}
console.log(`Copied ${STATIC_FILES.length} static files to dist/`);
