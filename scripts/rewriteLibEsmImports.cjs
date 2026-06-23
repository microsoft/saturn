// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/* eslint-disable no-console -- build helper reports actionable failures directly */
const { readFileSync, readdirSync, statSync, writeFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const libRoot = path.join(packageRoot, 'lib');
const knownExtensions = new Set([
  '.js',
  '.json',
  '.node',
  '.mjs',
  '.cjs',
  '.css',
  '.less',
  '.scss',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.woff',
  '.mp3'
]);

const specifierPatterns = [
  /(\bfrom\s*['"])(\.[^'"]+)(['"])/g,
  /(\bimport\s*['"])(\.[^'"]+)(['"])/g,
  /(\bimport\s*\(\s*['"])(\.[^'"]+)(['"]\s*\))/g
];

function getJavaScriptSpecifier(specifier) {
  if (!specifier.startsWith('.')) {
    return specifier;
  }

  for (const extension of knownExtensions) {
    if (specifier.endsWith(extension)) {
      return specifier;
    }
  }

  return `${specifier}.js`;
}

function rewriteFile(filePath) {
  const original = readFileSync(filePath, 'utf8');
  let updated = original;
  for (const pattern of specifierPatterns) {
    updated = updated.replace(pattern, (_match, prefix, specifier, suffix) => {
      return `${prefix}${getJavaScriptSpecifier(specifier)}${suffix}`;
    });
  }

  if (updated !== original) {
    writeFileSync(filePath, updated, 'utf8');
    return 1;
  }

  return 0;
}

function rewriteDirectory(directoryPath) {
  let changedFileCount = 0;
  for (const childName of readdirSync(directoryPath)) {
    const childPath = path.join(directoryPath, childName);
    const childStats = statSync(childPath);
    if (childStats.isDirectory()) {
      changedFileCount += rewriteDirectory(childPath);
      continue;
    }

    if (childPath.endsWith('.js')) {
      changedFileCount += rewriteFile(childPath);
    }
  }

  return changedFileCount;
}

if (!existsSync(libRoot)) {
  process.exit(0);
}

const changedFileCount = rewriteDirectory(libRoot);
if (changedFileCount > 0) {
  console.log(`Rewrote relative ESM imports in ${String(changedFileCount)} built file(s).`);
}
