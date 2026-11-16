import fs from 'node:fs';
import { importExport } from './importExport.js';
import { importHevyCsv, looksLikeHevyCsv } from './hevy.js';

// Picks the importer from the file's first bytes: Apple Health zip/xml or a Hevy CSV.
export async function runImport(file, onProgress) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4096);
  const n = fs.readSync(fd, head, 0, 4096, 0);
  fs.closeSync(fd);
  const text = head.subarray(0, n).toString('utf8').replace(/^﻿/, '');
  if (looksLikeHevyCsv(text.split('\n')[0])) return { kind: 'hevy', ...importHevyCsv(file) };
  if (text.startsWith('PK') || text.startsWith('<?xml') || text.includes('<HealthData')) return { kind: 'export', ...(await importExport(file, onProgress)) };
  throw new Error('Unrecognised file. Use Apple Health’s export.zip or a Hevy workouts CSV.');
}
