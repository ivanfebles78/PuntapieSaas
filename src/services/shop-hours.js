// Horario de Puntapié. Lunes a viernes, mañana y tarde; sábado, solo mañana;
// domingo, cerrado. El sábado por la tarde y el domingo por la mañana solo se
// abren de forma puntual («aperturas extra»), y cada hora trabajada en ellas
// se compensa con dos de descanso.

export const SHIFTS = Object.freeze({
  manana: Object.freeze({ id: 'manana', label: 'Mañana', start: '10:00', end: '13:30' }),
  tarde: Object.freeze({ id: 'tarde', label: 'Tarde', start: '16:30', end: '20:00' }),
});
export const SHIFT_IDS = Object.freeze(Object.keys(SHIFTS));
export const SHIFT_MINUTES = 210; // 3,5 h cada turno
export const BONUS_MULTIPLIER = 2; // 1 h extra = 2 h de descanso
export const BONUS_MINUTES_PER_SHIFT = SHIFT_MINUTES * BONUS_MULTIPLIER; // 7 h = 2 turnos libres

// Antes de las 15:00 es mañana; desde las 15:00, tarde (entre los dos turnos la tienda cierra).
export const SHIFT_CUTOFF_HOUR = 15;

export const WEEKDAY_NAMES = Object.freeze(['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']);

/** Turnos normales: «1-manana» … «5-tarde» y «6-manana». */
export const REGULAR_SLOTS = Object.freeze([
  ...[1, 2, 3, 4, 5].flatMap((d) => [`${d}-manana`, `${d}-tarde`]),
  '6-manana',
]);

/** Turnos que solo se abren de forma puntual: sábado tarde y domingo mañana. */
export const EXTRA_SLOTS = Object.freeze(['6-tarde', '7-manana']);

export const slotKey = (weekday, shift) => `${weekday}-${shift}`;

export function shiftOfTime(time) {
  return Number(time.slice(0, 2)) < SHIFT_CUTOFF_HOUR ? 'manana' : 'tarde';
}

export function shiftLabel(shift) {
  const s = SHIFTS[shift];
  return s ? `${s.label} (${s.start}–${s.end})` : shift;
}

export const isRegularSlot = (weekday, shift) => REGULAR_SLOTS.includes(slotKey(weekday, shift));
export const isExtraSlot = (weekday, shift) => EXTRA_SLOTS.includes(slotKey(weekday, shift));

/** Horario en formato de la API, para que el navegador no lo repita. */
export function shopHours() {
  return {
    shifts: SHIFT_IDS.map((id) => ({ ...SHIFTS[id] })),
    shiftMinutes: SHIFT_MINUTES,
    bonusMultiplier: BONUS_MULTIPLIER,
    regularSlots: REGULAR_SLOTS,
    extraSlots: EXTRA_SLOTS,
  };
}
