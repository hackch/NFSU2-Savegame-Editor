import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const buildNumber = new Date().toISOString().replace(/\D/g, '').slice(0, 14);

/** Files served as-is next to the compiled modules. */
const STATIC_FILES = ['index.html', 'app.css', 'editor.css', 'car-donors.json'];

mkdirSync(out, { recursive: true });
for (const file of STATIC_FILES) {
  copyFileSync(join(root, file), join(out, file));
}
const indexPath = join(out, 'index.html');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8')
  .replaceAll('__APP_VERSION__', version)
  .replaceAll('__BUILD_NUMBER__', buildNumber));
console.log(`Copied ${STATIC_FILES.length} static files to dist/`);
console.log(`Built v${version}, build ${buildNumber} (UTC)`);
