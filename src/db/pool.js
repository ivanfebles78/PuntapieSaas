import pg from 'pg';

const { Pool } = pg;

// Railway conecta por red privada sin SSL; forzarlo aborta el arranque.
// Se activa solo si la URL lleva sslmode=require o PGSSL/PGSSLMODE lo piden.
export function shouldUseSsl(databaseUrl, env = process.env) {
  if (env.PGSSL === 'true' || env.PGSSL === '1') return true;
  if (env.PGSSLMODE && env.PGSSLMODE !== 'disable') return true;
  return /sslmode=require/i.test(databaseUrl);
}

export function createPool(databaseUrl) {
  return new Pool({
    connectionString: databaseUrl,
    ssl: shouldUseSsl(databaseUrl) ? { rejectUnauthorized: false } : false,
    max: 10,
  });
}
