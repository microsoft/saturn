/* eslint-disable no-console -- build helper reports progress and actionable failures directly */
// Builds a standalone Windows/macOS/Linux executable for saturn:
//   1. Bundle src/start.ts (and all deps, including zod) into a single self-contained CJS file.
//   2. Wrap it as a Node Single Executable Application (SEA): generate a blob, copy the node
//      runtime, and inject the blob with postject.
// The resulting binary can be copied anywhere and run outside the office-bohemia repo; on first run
// it clones office-bohemia into ~/Documents/code/office-bohemia and reviews from that managed clone.
const { execFileSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const distDir = path.join(packageRoot, 'dist');
const bundlePath = path.join(distDir, 'saturn.cjs');
const blobPath = path.join(distDir, 'sea-prep.blob');
const seaConfigPath = path.join(distDir, 'sea-config.json');
const isWindows = process.platform === 'win32';
const exePath = path.join(distDir, isWindows ? 'saturn.exe' : 'saturn');

function run(command, args, useShell) {
  execFileSync(command, args, { stdio: 'inherit', cwd: packageRoot, shell: useShell === true });
}

mkdirSync(distDir, { recursive: true });

console.log('[1/4] Bundling with esbuild...');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- build-time only, esbuild is hoisted
const { buildSync } = require('esbuild');
buildSync({
  entryPoints: [path.join(packageRoot, 'src', 'start.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'info'
});

console.log('[2/4] Writing SEA config...');
writeFileSync(
  seaConfigPath,
  `${JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2)}\n`,
  'utf8'
);

console.log('[3/4] Generating SEA blob...');
run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

console.log('[4/4] Creating executable and injecting blob...');
if (existsSync(exePath)) {
  rmSync(exePath);
}
copyFileSync(process.execPath, exePath);

const postjectArgs = [
  '-y',
  'postject',
  exePath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
];
if (process.platform === 'darwin') {
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}
run(isWindows ? 'npx.cmd' : 'npx', postjectArgs, isWindows);

console.log(`\nBuilt standalone executable: ${exePath}`);
console.log('Run it from anywhere, for example:');
console.log(`  "${exePath}" --list-only`);
console.log(`  "${exePath}" --pr 5311321        (dry-run)`);
console.log(`  "${exePath}" --pr 5311321 --post (publish)`);
