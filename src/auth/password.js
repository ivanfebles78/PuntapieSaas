import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 10;
export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72; // límite de bcrypt

export function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/**
 * Devuelve un mensaje de error o null si la contraseña nueva es válida.
 */
export function validateNewPassword(password, confirmation) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `La contraseña no puede superar ${MAX_PASSWORD_LENGTH} caracteres.`;
  }
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) {
    return 'La contraseña debe combinar letras y números.';
  }
  if (password !== confirmation) {
    return 'Las dos contraseñas no coinciden.';
  }
  return null;
}
