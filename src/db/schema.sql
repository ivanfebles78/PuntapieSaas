-- Esquema idempotente: se aplica en cada arranque sin necesidad de migraciones.

CREATE TABLE IF NOT EXISTS users (
  id                  SERIAL PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  password_hash       TEXT NOT NULL,
  -- 'admin' = Administrador (acceso total). Más roles y permisos por módulo llegarán después.
  role                TEXT NOT NULL DEFAULT 'admin',
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  password_changed_at TIMESTAMPTZ
);

-- Se guarda el SHA-256 de cada token, nunca el token en claro.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS password_resets_user_id_idx ON password_resets(user_id);

-- Gestión del equipo: invitaciones (sin contraseña hasta aceptarla), bajas y último acceso.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at     TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by     INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- 'reset' = restablecer contraseña; 'invite' = invitación para crearla.
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'reset';

-- Acceso con usuario o con correo: las cuentas creadas a mano pueden no tener correo.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username)) WHERE username IS NOT NULL;

-- Obliga a elegir contraseña propia en el primer acceso.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- Vacaciones por persona (días naturales, ambos extremos incluidos).
CREATE TABLE IF NOT EXISTS vacations (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS vacations_user_start_idx ON vacations(user_id, start_date);

-- Inicio de contrato: prorratea los 30 días de vacaciones del primer año.
ALTER TABLE users ADD COLUMN IF NOT EXISTS contract_start DATE;

-- Los días no usados en el año se pierden: ya no hay pendientes que arrastrar.
DROP TABLE IF EXISTS vacation_carryovers;

-- Solo existen dos roles: 'admin' (todo) y 'empleado' (vista limitada).
UPDATE users SET role = 'empleado' WHERE role NOT IN ('admin', 'empleado');
