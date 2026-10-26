import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.env.AETHR_EDIT_LAYER_ROOT ?? join(root, '../aethr-edit-layer'));
const target = join(root, 'src/lib/edit/shared');
const lockPath = join(root, 'scripts/edit-layer-lock.json');
const names = ['lib/html.mjs','lib/html.d.mts','lib/template.mjs','lib/template.d.mts','declarations.mjs','declarations.d.mts','bundle.mjs','bundle.d.mts'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null;
const refresh = process.argv.includes('--refresh-lock');
if (refresh && !existsSync(source)) throw new Error('Refreshing the lock requires the canonical local package');
const files = new Map();
for (const name of names) {
  let bytes;
  if (existsSync(source)) bytes = readFileSync(join(source, name));
  else {
    if (!lock) throw new Error('No shared package or integrity lock available');
    const response = await fetch(`${lock.base}${name}`);
    if (!response.ok) throw new Error(`Shared package fetch failed: ${name} (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (!refresh && (!lock || lock.files[name] !== hash(bytes))) throw new Error(`Shared package integrity changed at ${name}; verify the change, then refresh the lock`);
  files.set(name, bytes);
}
if (refresh) {
  lock = {base: 'https://portal.aethrdesign.com/edit-layer/0.1.0/', files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)]))};
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}
for (const [name, bytes] of files) {
  mkdirSync(dirname(join(target, name)), {recursive: true});
  writeFileSync(join(target, name), bytes);
}
console.log(`sync-edit-layer: ${files.size} integrity-checked shared modules`);

// CMS uses a new immutable transport; the existing eight-file lock stays untouched.
const cmsNames = ['cms/contract.mjs', 'cms/contract.d.mts', 'cms/view-model.mjs', 'cms/view-model.d.mts', 'native-runtime.mjs', 'native-runtime.d.mts'];
const cmsLockPath = join(root, 'scripts/edit-layer-cms-lock.json');
let cmsLock = existsSync(cmsLockPath) ? JSON.parse(readFileSync(cmsLockPath, 'utf8')) : null;
const refreshCms = process.argv.includes('--refresh-cms-lock');
if (refreshCms && !existsSync(source)) throw new Error('Refreshing the CMS lock requires the canonical local package');
const cmsFiles = new Map();
for (const name of cmsNames) {
  let bytes;
  if (existsSync(source)) bytes = readFileSync(join(source, name));
  else {
    if (!cmsLock) throw new Error('No CMS integrity lock available');
    const response = await fetch(`${cmsLock.base}${name}`);
    if (!response.ok) throw new Error(`CMS package fetch failed: ${name} (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (!refreshCms && (!cmsLock || cmsLock.files[name] !== hash(bytes))) throw new Error(`CMS integrity changed at ${name}; verify the change, then refresh the CMS lock`);
  cmsFiles.set(name, bytes);
}
if (refreshCms) {
  cmsLock = { base: 'https://portal.aethrdesign.com/edit-layer/0.2.0/', files: Object.fromEntries([...cmsFiles].map(([name, bytes]) => [name, hash(bytes)])) };
  writeFileSync(cmsLockPath, JSON.stringify(cmsLock, null, 2) + '\n');
}
for (const [name, bytes] of cmsFiles) {
  mkdirSync(dirname(join(target, name)), { recursive: true });
  writeFileSync(join(target, name), bytes);
}
console.log(`sync-edit-layer: ${cmsFiles.size} integrity-checked CMS modules`);
