import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;

export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}
