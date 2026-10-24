import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../auth/password.js';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

export async function applySchema(pool) {
  const sql = await readFile(SCHEMA_PATH, 'utf8');
  await pool.query(sql);
}

/**
 * Crea la cuenta de administración solo si aún no existe. Nunca
 * sobreescribe una contraseña ya cambiada. Usa ADMIN_INITIAL_PASSWORD si
 * se define; si no, el hash ya calculado de la configuración.
 */
export async function seedAdmin(pool, cfg, log = console) {
  if (!cfg.adminEmail) {
    const any = await pool.query('SELECT 1 FROM users LIMIT 1');
    if (any.rowCount === 0) {
      log.warn('[seed] Define ADMIN_EMAIL para crear la primera cuenta.');
    }
    return;
  }
  const passwordHash = cfg.adminInitialPassword
    ? await hashPassword(cfg.adminInitialPassword)
    : cfg.adminPasswordHash;
  const result = await pool.query(
    `INSERT INTO users (email, name, password_hash, role, is_seller)
     VALUES ($1, $2, $3, 'admin', FALSE)
     ON CONFLICT (email) DO NOTHING`,
    [cfg.adminEmail, cfg.adminName, passwordHash],
  );
  if (result.rowCount > 0) log.info(`[seed] Cuenta de administración ${cfg.adminEmail} creada.`);
}
