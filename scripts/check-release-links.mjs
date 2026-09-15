#!/usr/bin/env node
// Keep public links and the page's explicit installer selections in lockstep
// with the same contract used to stage release assets. No network required.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const pagePath = 'apps/website/src/app/download/page.tsx';
const assets = JSON.parse(await readFile(path.join(root, 'scripts/release-assets.json'), 'utf8'));
const names = new Set();
const errors = [];
for (const asset of assets) {
  if (typeof asset.name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(asset.name)) {
    errors.push(`Invalid asset name: ${JSON.stringify(asset.name)}`);
  } else if (names.has(asset.name)) {
    errors.push(`Duplicate asset name: ${asset.name}`);
  } else {
    names.add(asset.name);
  }
}
if (names.size === 0) errors.push('The release asset contract is empty');

async function filesIn(relative) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(file));
    else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|mdx?|json|html|css|txt)$/.test(entry.name)) files.push(file);
  }
  return files;
}

const page = await readFile(path.join(root, pagePath), 'utf8');
const selected = [...page.matchAll(/\binstaller\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
for (const name of selected) {
  if (!names.has(name)) errors.push(`${pagePath}: unknown installer ${name}`);
}
for (const name of names) {
  if (!selected.includes(name)) errors.push(`${pagePath}: missing installer ${name}`);
}
if (selected.length !== new Set(selected).size) errors.push(`${pagePath}: duplicate installer selection`);

const files = ['README.md', ...await filesIn('apps/website/src'), ...await filesIn('docs')];
let literalLinks = 0;
let templateLinks = 0;
for (const file of files) {
  const source = await readFile(path.join(root, file), 'utf8');
  for (const match of source.matchAll(/\/releases\/latest\/download\/([^\s"'`<>\)\]]+)/g)) {
    const name = match[1];
    // This page resolves each explicit installer selection through the JSON
    // contract. All other links must contain a literal, known asset name.
    if (file === pagePath && name === '${asset.name}') {
      templateLinks++;
      continue;
    }
    literalLinks++;
    if (!names.has(name)) errors.push(`${file}: unknown release download ${name}`);
  }
}
if (templateLinks !== 1) errors.push(`${pagePath}: expected one download URL using the resolved asset.name`);
if (!/import\s+releaseAssets\s+from\s+["'][^"']*scripts\/release-assets\.json["']/.test(page)) {
  errors.push(`${pagePath}: must import the shared release asset contract`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Release links OK: ${names.size} installers on /download, ${literalLinks} literal links checked across ${files.length} files.`);
}
