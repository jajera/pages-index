#!/usr/bin/env node
/**
 * Guard the pages index against empty-data / empty-build regressions.
 *
 * Usage:
 *   node scripts/check-index.mjs data   # committed discovery snapshot
 *   node scripts/check-index.mjs dist   # built site output
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || 'data';

function fail(message) {
  console.error(`check-index (${mode}): ${message}`);
  process.exit(1);
}

function checkData() {
  const dataPath = path.join(root, 'data', 'repositories.json');
  if (!existsSync(dataPath)) {
    fail(`missing ${path.relative(root, dataPath)}`);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(dataPath, 'utf8'));
  } catch (err) {
    fail(`invalid JSON in data/repositories.json: ${err.message}`);
  }

  if (!Array.isArray(data.repositories)) {
    fail('data.repositories must be an array');
  }
  if (data.repositories.length < 1) {
    fail('data.repositories is empty; refusing to ship an empty index');
  }

  const count = data.repositories.length;
  const meta = data.metadata?.totalCount;
  if (typeof meta === 'number' && meta !== count) {
    fail(`metadata.totalCount (${meta}) does not match repositories.length (${count})`);
  }

  console.log(`check-index (data): ok (${count} repositories)`);
}

function checkDist() {
  const indexPath = path.join(root, 'dist', 'index.html');
  if (!existsSync(indexPath)) {
    fail('dist/index.html is missing; run npm run build first');
  }

  const bytes = statSync(indexPath).size;
  if (bytes < 1024) {
    fail(`dist/index.html is only ${bytes} bytes; expected a populated index`);
  }

  const html = readFileSync(indexPath, 'utf8');
  if (html.includes('No repositories in the index yet')) {
    fail('dist/index.html still shows the empty-state message');
  }
  if (!html.includes('id="entry-list"') && !html.includes("id='entry-list'")) {
    fail('dist/index.html is missing the entry list');
  }
  if (!html.includes('github.com/')) {
    fail('dist/index.html has no github.com links; repositories were not rendered');
  }

  const rssPath = path.join(root, 'dist', 'rss.xml');
  if (!existsSync(rssPath)) {
    fail('dist/rss.xml is missing');
  }
  const rss = readFileSync(rssPath, 'utf8');
  if (!rss.includes('<item>')) {
    fail('dist/rss.xml has no <item> entries');
  }

  console.log(`check-index (dist): ok (${bytes} byte index, rss items present)`);
}

if (mode === 'data') {
  checkData();
} else if (mode === 'dist') {
  checkDist();
} else {
  fail(`unknown mode "${mode}" (use data|dist)`);
}
