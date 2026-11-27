/** Five-field cron, from Office's schedule/cron.ts. */
export interface Cron {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 is Sunday. */
  weekdays: ReadonlySet<number>;
  domStar: boolean;
  dowStar: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec {
  min: number;
  max: number;
  names?: string[];
  nameBase?: number;
}

const SPECS: FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { min: 0, max: 7, names: DAYS, nameBase: 0 },
];

function bad(expr: string, why: string): Error {
  return new Error(`"${expr}" is not a valid cron expression: ${why}`);
}

function value(token: string, spec: FieldSpec, expr: string): number {
  const named = spec.names?.indexOf(token.toLowerCase()) ?? -1;
  const n = named >= 0 ? named + (spec.nameBase ?? 0) : /^\d+$/.test(token) ? Number(token) : NaN;
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) throw bad(expr, `${token} is out of range`);
  return n;
}

function field(text: string, spec: FieldSpec, expr: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw bad(expr, `step ${stepText} must be a whole number above 0`);
    const [lo, hi] = range === '*' ? [spec.min, spec.max] : range.split('-').map((t) => value(t, spec, expr));
    const end = range === '*' || range.includes('-') ? hi : stepText === undefined ? lo : spec.max;
    if (lo === undefined || end === undefined || lo > end) throw bad(expr, `${part} is not a range`);
    for (let v = lo; v <= end; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw bad(expr, 'it needs five fields');
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => field(p, SPECS[i] as FieldSpec, expr)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minutes: new Set([...minutes].sort((a, b) => a - b)),
    hours: new Set([...hours].sort((a, b) => a - b)),
    days,
    months,
    weekdays: new Set([...weekdays].sort((a, b) => a - b)),
    domStar: parts[2]?.startsWith('*') ?? false,
    dowStar: parts[4]?.startsWith('*') ?? false,
  };
}

/** Whether a local calendar date (YYYY-MM-DD) is a day the cron runs; day-of-month and weekday combine as in cron(8). */
export function cronMatchesDay(cron: Cron, date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  if (!cron.months.has(d.getUTCMonth() + 1)) return false;
  const dom = cron.days.has(d.getUTCDate());
  const dow = cron.weekdays.has(d.getUTCDay());
  if (cron.domStar || cron.dowStar) return dom && dow;
  return dom || dow;
}
