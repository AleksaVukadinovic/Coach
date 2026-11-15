// Usage: npm run import -- ~/Downloads/export.zip
import { importExport } from '../lib/importExport.js';
import { writeExports, EXPORT_DIR } from '../lib/exporter.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import -- <path to export.zip or export.xml>');
  process.exit(1);
}

const t0 = Date.now();
const result = await importExport(file, ({ bytes, total, records }) => {
  const pct = total ? ` (${Math.round((bytes / total) * 100)}%)` : '';
  process.stdout.write(`\r${(bytes / 1e6).toFixed(0)} MB${pct} · ${records.toLocaleString()} records`);
});
writeExports();
console.log(`\nImported ${result.records.toLocaleString()} records → ${result.days} days, ${result.values} daily values, ${result.workouts} workouts in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`LLM-ready files: ${EXPORT_DIR}`);
