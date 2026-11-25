/**
 * Small, locale-free formatters (the UI shows the same strings everywhere, and
 * tests do not depend on ICU data). Times are shown in the viewer's local zone.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** Formats an ISO time for display. */
export type TimeFormatter = (iso: string, opts?: { seconds?: boolean; date?: boolean }) => string;

/** `2 Nov 2026, 09:00` (local time); `seconds` adds `:05`, `date: false` drops the date. */
export const formatTime: TimeFormatter = (iso, opts = {}) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${opts.seconds ? `:${pad(d.getSeconds())}` : ''}`;
  if (opts.date === false) return time;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${time}`;
};

/** Whether two ISO times fall on the same local day. */
export function sameDay(a: string, b: string): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
  );
}

/** `1 h 05 min`, `4 min`, `12 s`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
}

/** `1234567` → `1,234,567`. */
export function formatCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `1 word`, `3 words`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/**
 * A share as a percentage with one decimal. A class that is present but not the
 * whole never shows as 0% or 100%, so rounding cannot overclaim or hide it.
 */
export function formatShare(count: number, total: number): string {
  if (total <= 0 || count <= 0) return '0%';
  if (count >= total) return '100%';
  const p = Math.min(99.9, Math.max(0.1, Math.round((count / total) * 1000) / 10));
  return `${p.toFixed(1)}%`;
}

/** Trims text to `max` characters on a word boundary, with an ellipsis. */
export function excerpt(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, '')}…`;
}
