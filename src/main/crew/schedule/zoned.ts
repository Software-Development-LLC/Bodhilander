/** Wall-clock dates and times in an IANA zone, from Office's time/zoned.ts. */
const formats = new Map<string, Intl.DateTimeFormat>();

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formats.set(tz, f);
  }
  return f;
}

function fields(at: Date, tz: string): Record<string, string> {
  return Object.fromEntries(format(tz).formatToParts(at).map((p) => [p.type, p.value]));
}

/** The local calendar date, YYYY-MM-DD. */
export function zonedDate(at: Date, tz: string): string {
  const f = fields(at, tz);
  return `${f.year}-${f.month}-${f.day}`;
}

/** The local HH:MM. */
export function zonedTime(at: Date, tz: string): string {
  const f = fields(at, tz);
  return `${f.hour}:${f.minute}`;
}

function offsetMs(at: Date, tz: string): number {
  const f = fields(at, tz);
  const wall = Date.UTC(Number(f.year), Number(f.month) - 1, Number(f.day), Number(f.hour), Number(f.minute), Number(f.second));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a wall-clock `HH:MM` on `date` happens in `tz`; a wall time DST skips or repeats maps to one instant. */
export function zonedToUtc(date: string, hhmm: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  const guess = wall - offsetMs(new Date(wall), tz);
  return new Date(wall - offsetMs(new Date(guess), tz));
}

export function addDays(date: string, n: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export function isZone(tz: string): boolean {
  try {
    format(tz);
    return true;
  } catch {
    return false;
  }
}
