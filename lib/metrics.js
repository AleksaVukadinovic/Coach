// Metric catalogue: one entry per daily value we track.
//   agg:    how many samples in a day become one value
//           sum  – summed per source, then the largest source wins (avoids iPhone + Watch double counting)
//           avg  – mean of all samples
//           min / max – extreme of all samples
//           last – most recent sample of the day
//   better: which direction is an improvement ('up' | 'down' | null) – used for delta colouring
//   hk:     Apple Health export type identifier
//   hae:    metric names sent by the "Health Auto Export" iOS app

export const CATEGORIES = [
  { key: 'activity', label: 'Activity' },
  { key: 'heart', label: 'Heart' },
  { key: 'sleep', label: 'Sleep' },
  { key: 'body', label: 'Body' },
  { key: 'nutrition', label: 'Nutrition' },
  { key: 'mind', label: 'Mind' },
];

export const METRICS = [
  { key: 'steps', label: 'Steps', unit: 'steps', category: 'activity', agg: 'sum', better: 'up', decimals: 0, hk: 'HKQuantityTypeIdentifierStepCount', hae: ['step_count'] },
  { key: 'distance', label: 'Walk + run distance', unit: 'km', category: 'activity', agg: 'sum', better: 'up', decimals: 1, hk: 'HKQuantityTypeIdentifierDistanceWalkingRunning', hae: ['walking_running_distance'] },
  { key: 'active_energy', label: 'Active energy', unit: 'kcal', category: 'activity', agg: 'sum', better: 'up', decimals: 0, hk: 'HKQuantityTypeIdentifierActiveEnergyBurned', hae: ['active_energy'] },
  { key: 'basal_energy', label: 'Resting energy', unit: 'kcal', category: 'activity', agg: 'sum', better: null, decimals: 0, hk: 'HKQuantityTypeIdentifierBasalEnergyBurned', hae: ['basal_energy_burned'] },
  { key: 'exercise_min', label: 'Exercise', unit: 'min', category: 'activity', agg: 'sum', better: 'up', decimals: 0, hk: 'HKQuantityTypeIdentifierAppleExerciseTime', hae: ['apple_exercise_time'] },
  { key: 'stand_hours', label: 'Stand hours', unit: 'h', category: 'activity', agg: 'sum', better: 'up', decimals: 0, hk: null, hae: ['apple_stand_hour'] },
  { key: 'flights', label: 'Flights climbed', unit: 'floors', category: 'activity', agg: 'sum', better: 'up', decimals: 0, hk: 'HKQuantityTypeIdentifierFlightsClimbed', hae: ['flights_climbed'] },

  { key: 'resting_hr', label: 'Resting heart rate', unit: 'bpm', category: 'heart', agg: 'avg', better: 'down', decimals: 0, hk: 'HKQuantityTypeIdentifierRestingHeartRate', hae: ['resting_heart_rate'] },
  { key: 'hrv', label: 'HRV (SDNN)', unit: 'ms', category: 'heart', agg: 'avg', better: 'up', decimals: 0, hk: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', hae: ['heart_rate_variability'] },
  { key: 'walking_hr', label: 'Walking heart rate', unit: 'bpm', category: 'heart', agg: 'avg', better: 'down', decimals: 0, hk: 'HKQuantityTypeIdentifierWalkingHeartRateAverage', hae: ['walking_heart_rate_average'] },
  { key: 'hr_avg', label: 'Heart rate (avg)', unit: 'bpm', category: 'heart', agg: 'avg', better: null, decimals: 0, hk: 'HKQuantityTypeIdentifierHeartRate', hae: ['heart_rate'], haeField: 'Avg' },
  { key: 'hr_max', label: 'Heart rate (max)', unit: 'bpm', category: 'heart', agg: 'max', better: null, decimals: 0, hk: 'HKQuantityTypeIdentifierHeartRate', hae: ['heart_rate'], haeField: 'Max' },
  { key: 'vo2max', label: 'VO₂ max', unit: 'ml/kg·min', category: 'heart', agg: 'avg', better: 'up', decimals: 1, hk: 'HKQuantityTypeIdentifierVO2Max', hae: ['vo2_max'] },
  { key: 'spo2', label: 'Blood oxygen', unit: '%', category: 'heart', agg: 'avg', better: 'up', decimals: 1, hk: 'HKQuantityTypeIdentifierOxygenSaturation', hae: ['blood_oxygen_saturation'] },
  { key: 'resp_rate', label: 'Respiratory rate', unit: 'br/min', category: 'heart', agg: 'avg', better: null, decimals: 1, hk: 'HKQuantityTypeIdentifierRespiratoryRate', hae: ['respiratory_rate'] },

  { key: 'sleep_total', label: 'Sleep', unit: 'h', category: 'sleep', agg: 'sleep', better: 'up', decimals: 1 },
  { key: 'sleep_deep', label: 'Deep sleep', unit: 'h', category: 'sleep', agg: 'sleep', better: 'up', decimals: 1 },
  { key: 'sleep_rem', label: 'REM sleep', unit: 'h', category: 'sleep', agg: 'sleep', better: 'up', decimals: 1 },
  { key: 'sleep_core', label: 'Core sleep', unit: 'h', category: 'sleep', agg: 'sleep', better: null, decimals: 1 },
  { key: 'sleep_awake', label: 'Awake in bed', unit: 'h', category: 'sleep', agg: 'sleep', better: 'down', decimals: 1 },
  { key: 'sleep_in_bed', label: 'Time in bed', unit: 'h', category: 'sleep', agg: 'sleep', better: null, decimals: 1 },

  { key: 'weight', label: 'Weight', unit: 'kg', category: 'body', agg: 'last', better: null, decimals: 1, hk: 'HKQuantityTypeIdentifierBodyMass', hae: ['weight_body_mass'] },
  { key: 'body_fat', label: 'Body fat', unit: '%', category: 'body', agg: 'last', better: 'down', decimals: 1, hk: 'HKQuantityTypeIdentifierBodyFatPercentage', hae: ['body_fat_percentage'] },
  { key: 'lean_mass', label: 'Lean body mass', unit: 'kg', category: 'body', agg: 'last', better: 'up', decimals: 1, hk: 'HKQuantityTypeIdentifierLeanBodyMass', hae: ['lean_body_mass'] },

  { key: 'calories_in', label: 'Calories eaten', unit: 'kcal', category: 'nutrition', agg: 'sum', better: null, decimals: 0, hk: 'HKQuantityTypeIdentifierDietaryEnergyConsumed', hae: ['dietary_energy'] },
  { key: 'protein', label: 'Protein', unit: 'g', category: 'nutrition', agg: 'sum', better: null, decimals: 0, hk: 'HKQuantityTypeIdentifierDietaryProtein', hae: ['protein'] },
  { key: 'water', label: 'Water', unit: 'L', category: 'nutrition', agg: 'sum', better: null, decimals: 1, hk: 'HKQuantityTypeIdentifierDietaryWater', hae: ['dietary_water'] },

  { key: 'mindful_min', label: 'Mindful minutes', unit: 'min', category: 'mind', agg: 'sum', better: 'up', decimals: 0, hk: 'HKCategoryTypeIdentifierMindfulSession', hae: ['mindful_minutes'], duration: true },
];

export const METRIC_BY_KEY = Object.fromEntries(METRICS.map(m => [m.key, m]));

// HK identifier -> metrics derived from it (heart rate feeds avg + max)
export const METRICS_BY_HK = {};
for (const m of METRICS) if (m.hk) (METRICS_BY_HK[m.hk] ||= []).push(m);

export const METRICS_BY_HAE = {};
for (const m of METRICS) for (const n of m.hae || []) (METRICS_BY_HAE[n] ||= []).push(m);

const FACTORS = {
  // energy -> kcal
  kcal: { kcal: 1, cal: 1, Cal: 1, kJ: 1 / 4.184, kj: 1 / 4.184, J: 1 / 4184 },
  // distance -> km
  km: { km: 1, m: 0.001, mi: 1.609344, ft: 0.0003048, yd: 0.0009144, cm: 0.00001 },
  // mass -> kg
  kg: { kg: 1, g: 0.001, lb: 0.45359237, lbs: 0.45359237, st: 6.35029318 },
  g: { g: 1, mg: 0.001, kg: 1000, oz: 28.3495 },
  // volume -> L
  L: { L: 1, l: 1, mL: 0.001, ml: 0.001, fl_oz_us: 0.0295735, 'fl oz': 0.0295735, cup_us: 0.236588 },
  // time -> minutes / hours
  min: { min: 1, s: 1 / 60, sec: 1 / 60, hr: 60, h: 60 },
  h: { h: 1, hr: 1, min: 1 / 60, s: 1 / 3600 },
};

// Convert a raw value in `fromUnit` to the metric's canonical unit.
export function toCanonical(metric, value, fromUnit) {
  if (!Number.isFinite(value)) return null;
  if (metric.unit === '%') return value <= 1 ? value * 100 : value; // Apple stores fractions with unit "%"
  const table = FACTORS[metric.unit];
  if (!table || !fromUnit) return value;
  const f = table[fromUnit] ?? table[fromUnit.trim()];
  return f == null ? value : value * f;
}

export function normalizeWorkoutType(raw) {
  if (!raw) return 'Workout';
  return raw
    .replace(/^HKWorkoutActivityType/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}
