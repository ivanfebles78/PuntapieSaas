// useGrouping 'always': «1.150,00 €» (por defecto es-ES no separa los miles con 4 cifras).
const euros = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', useGrouping: 'always' });
const monthName = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** 125050 → «1.250,50 €» */
export function formatEuros(cents) {
  return euros.format(cents / 100);
}

/** 125050 → «1250,50» (para rellenar un campo de importe). */
export function centsToInput(cents) {
  return (cents / 100).toFixed(2).replace('.', ',');
}

/** Mes actual del navegador como «AAAA-MM». */
export function currentMonth(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function isMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value ?? ''));
}

/** «2026-10» + 1 → «2026-11» */
export function shiftMonth(month, delta) {
  const [year, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** «2026-10» → «Octubre 2026» */
export function monthLabel(month) {
  const [year, m] = month.split('-').map(Number);
  const text = monthName.format(new Date(Date.UTC(year, m - 1, 1))).replace(' de ', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}
