// Usage: npm run import -- ~/Downloads/export.zip   (or a Hevy workouts CSV)
import { runImport } from '../lib/runImport.js';
import { writeExports, EXPORT_DIR } from '../lib/exporter.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import -- <export.zip | export.xml | hevy workouts.csv>');
  process.exit(1);
}

const t0 = Date.now();
const result = await runImport(file, ({ bytes, total, records }) => {
  const pct = total ? ` (${Math.round((bytes / total) * 100)}%)` : '';
  process.stdout.write(`\r${(bytes / 1e6).toFixed(0)} MB${pct} · ${records.toLocaleString()} records`);
});
writeExports();
const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (result.kind === 'hevy') {
  console.log(`Imported ${result.sessions} Hevy sessions (${result.sets} sets, ${result.addedWorkouts} not in Apple Health) in ${secs}s`);
} else {
  console.log(`\nImported ${result.records.toLocaleString()} records → ${result.days} days, ${result.values} daily values, ${result.workouts} workouts in ${secs}s`);
}
console.log(`LLM-ready files: ${EXPORT_DIR}`);
