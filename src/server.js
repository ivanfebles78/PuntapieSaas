import { assertConfig, config } from './config.js';
import { createApp } from './app.js';
import { createPool } from './db/pool.js';
import { applySchema, seedAdmin } from './db/migrate.js';
import { seedTeam } from './db/seed-team.js';
import { iniciarSincronizacionDiaria } from './antiguo/programador.js';
import { iniciarRevisionDiaria } from './correo/programador.js';
import { limpiarTemporales } from './proveedores/analisis.js';
import { caducarReservas } from './tpv/reservas.js';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

async function cleanupExpired(pool) {
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
  await pool.query("DELETE FROM password_resets WHERE expires_at < NOW() - INTERVAL '1 day'");
  // PDF analizados en «Importar PDF» y nunca guardados (24 h).
  await limpiarTemporales(pool);
  // Reservas vencidas (su stock ya estaba libre) y contacto de las cerradas hace 30 días.
  await caducarReservas(pool);
}

async function main() {
  assertConfig(config);
  const pool = createPool(config.databaseUrl);

  await applySchema(pool);
  await seedAdmin(pool, config);
  await seedTeam(pool);
  await cleanupExpired(pool).catch((error) => console.error('[limpieza] Al arrancar:', error.message));

  const cleanup = setInterval(() => {
    cleanupExpired(pool).catch((error) => {
      console.error('[limpieza] No se pudieron borrar registros caducados:', error.message);
    });
  }, CLEANUP_INTERVAL_MS);
  cleanup.unref();

  // Cada día, a partir de las 8:00, mira el correo y registra facturas, pedidos y gastos.
  iniciarRevisionDiaria({ pool, config });
  // Y se trae de gestiondegastos (app antigua) las ventas y gastos que falten.
  iniciarSincronizacionDiaria({ pool, config });

  const app = createApp({ pool, config });
  const server = app.listen(config.port, () => {
    console.log(`Puntapié gestión escuchando en http://localhost:${config.port}`);
  });

  const shutdown = (signal) => {
    console.log(`Recibido ${signal}, cerrando...`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('No se pudo arrancar la aplicación:', error.message);
  process.exit(1);
});
