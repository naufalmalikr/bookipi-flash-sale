export function toneFor(code: string): string {
  switch (code) {
    case 'purchased':
      return 'alert-success';
    case 'already-purchased':
      return 'alert-repeat';
    case 'sold-out':
      return 'alert-soldout';
    case 'sale-not-active':
      return 'alert-inactive';
    case 'invalid-userId':
      return 'alert-invalid';
    case 'rate-limited':
      return 'alert-rate';
    case 'not-purchased':
      return 'alert-notpurchased';
    default:
      return 'alert-error';
  }
}

export function formatDelta(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (d > 0) return `${String(d)}d ${pad(h)}h ${pad(m)}m ${pad(sec)}s`;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
