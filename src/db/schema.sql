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
UPDATE users SET role = 'empleado' WHERE role NOT IN ('admin', 'asesor', 'empleado');

-- ===================== Gastos recurrentes =====================
-- Un gasto que se paga cada mes. 'fijo' arrastra su importe mes a mes;
-- 'variable' empieza cada mes en 0 y se escribe a mano.
CREATE TABLE IF NOT EXISTS recurring_expenses (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('fijo', 'variable')),
  start_month DATE NOT NULL,
  end_month   DATE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_month IS NULL OR end_month >= start_month)
);

-- Historial del importe de los gastos fijos: cada fila vale desde su mes.
CREATE TABLE IF NOT EXISTS recurring_amounts (
  expense_id   INTEGER NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,
  from_month   DATE NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (expense_id, from_month)
);

-- Lo concreto de cada mes: importe (variable o cambio puntual) y estado.
CREATE TABLE IF NOT EXISTS recurring_entries (
  id           SERIAL PRIMARY KEY,
  expense_id   INTEGER NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,
  month        DATE NOT NULL,
  amount_cents INTEGER CHECK (amount_cents >= 0),
  status       TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'pagado')),
  paid_at      TIMESTAMPTZ,
  UNIQUE (expense_id, month)
);

-- Facturas y justificantes de pago (en la base de datos: el disco de Railway se borra al desplegar).
CREATE TABLE IF NOT EXISTS expense_files (
  id          SERIAL PRIMARY KEY,
  entry_id    INTEGER NOT NULL REFERENCES recurring_entries(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('factura', 'justificante')),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  data        BYTEA NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS expense_files_entry_idx ON expense_files(entry_id);

-- ===================== Una sola tabla de gastos =====================
-- Cada gasto lleva su tipo: 'recurrente' (fijo o variable, cada mes),
-- 'esporadico' o 'proveedor' (un único pago, kind = 'unico', en la fecha indicada).
ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'recurrente';
ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS expense_date DATE;
ALTER TABLE recurring_expenses DROP CONSTRAINT IF EXISTS recurring_expenses_kind_check;
ALTER TABLE recurring_expenses ADD CONSTRAINT recurring_expenses_kind_check
  CHECK (kind IN ('fijo', 'variable', 'unico'));
ALTER TABLE recurring_expenses DROP CONSTRAINT IF EXISTS recurring_expenses_category_check;
ALTER TABLE recurring_expenses ADD CONSTRAINT recurring_expenses_category_check
  CHECK (category IN ('recurrente', 'esporadico', 'proveedor'));

-- ===================== Ventas y objetivos =====================
-- Cada venta (ticket) del TPV. De momento solo la lee Estadísticas.
CREATE TABLE IF NOT EXISTS sales (
  id             SERIAL PRIMARY KEY,
  sold_at        TIMESTAMPTZ NOT NULL,
  total_cents    INTEGER NOT NULL CHECK (total_cents >= 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('efectivo', 'tarjeta', 'bizum', 'bonos', 'vales')),
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sales_sold_at_idx ON sales(sold_at);

-- Ajustes de la tienda (p. ej. objetivos de venta), como JSON por clave.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===================== Turnos y horas bonificadas =====================
-- Turnos fijos de cada persona. Cada fila vale desde `valid_from` hasta la
-- siguiente: así un cambio de turno no reescribe las estadísticas pasadas.
-- `slots`: lista de «díaSemana-turno» (1 = lunes … 6 = sábado), p. ej. {1-manana,6-manana}.
CREATE TABLE IF NOT EXISTS work_schedules (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  valid_from DATE NOT NULL,
  slots      TEXT[] NOT NULL DEFAULT '{}',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, valid_from)
);

-- Aperturas puntuales fuera del horario normal (sábado tarde o domingo mañana).
CREATE TABLE IF NOT EXISTS special_openings (
  id         SERIAL PRIMARY KEY,
  day        DATE NOT NULL,
  shift      TEXT NOT NULL CHECK (shift IN ('manana', 'tarde')),
  note       TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (day, shift)
);

-- Quién trabaja cada apertura extra: cada una da 2 h de descanso por hora trabajada.
CREATE TABLE IF NOT EXISTS special_opening_staff (
  opening_id INTEGER NOT NULL REFERENCES special_openings(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (opening_id, user_id)
);

-- Turnos libres pagados con horas bonificadas (cada uno descuenta un turno, 3,5 h).
CREATE TABLE IF NOT EXISTS free_shifts (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  shift      TEXT NOT NULL CHECK (shift IN ('manana', 'tarde')),
  note       TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, day, shift)
);

-- ===================== Log de acciones =====================
-- Una fila por campo cambiado. Nombre y valores se copian en texto para que
-- el historial no cambie aunque luego se borre o renombre lo que se tocó.
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name    TEXT NOT NULL DEFAULT '',
  area         TEXT NOT NULL,
  action       TEXT NOT NULL,
  target       TEXT NOT NULL DEFAULT '',
  field        TEXT,
  old_value    TEXT,
  new_value    TEXT,
  ip           TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log(user_id, at DESC);

-- ===================== Pagos a proveedores =====================
-- Migrado de «Control de facturas» (FacturasPuntaPie). Facturas y pedidos de
-- proveedores con sus vencimientos y pagos. Los PDF y justificantes viven en
-- supplier_files (un mismo justificante puede cubrir varios vencimientos).
CREATE TABLE IF NOT EXISTS supplier_files (
  id          SERIAL PRIMARY KEY,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS supplier_files_sha_idx ON supplier_files(sha256);

CREATE TABLE IF NOT EXISTS suppliers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  cif         TEXT UNIQUE,
  notes       TEXT,
  legacy_id   INTEGER UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- TRUE: el proveedor carga las facturas en cuenta (domiciliación); FALSE: hay que hacerle transferencia.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS direct_debit BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS supplier_docs (
  id              SERIAL PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('factura', 'pedido')),
  supplier_id     INTEGER NOT NULL REFERENCES suppliers(id),
  number          TEXT NOT NULL,
  doc_date        DATE,
  total_cents     INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  payment_terms   TEXT,
  delivery_date   DATE,
  orders          JSONB NOT NULL DEFAULT '[]',
  delivery_notes  JSONB NOT NULL DEFAULT '[]',
  file_id         INTEGER REFERENCES supplier_files(id) ON DELETE SET NULL,
  file_hash       TEXT,
  notes           TEXT,
  parser          TEXT,
  confidence      TEXT,
  manual_state    TEXT CHECK (manual_state IN ('recibido', 'cancelado')),
  legacy_id       INTEGER UNIQUE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_id, kind, number)
);

CREATE INDEX IF NOT EXISTS supplier_docs_date_idx ON supplier_docs(doc_date);
CREATE INDEX IF NOT EXISTS supplier_docs_hash_idx ON supplier_docs(file_hash);

CREATE TABLE IF NOT EXISTS supplier_dues (
  id            SERIAL PRIMARY KEY,
  doc_id        INTEGER NOT NULL REFERENCES supplier_docs(id) ON DELETE CASCADE,
  due_date      DATE NOT NULL,
  amount_cents  INTEGER NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS supplier_dues_doc_idx ON supplier_dues(doc_id);
CREATE INDEX IF NOT EXISTS supplier_dues_date_idx ON supplier_dues(due_date);

-- Un pago por vencimiento.
CREATE TABLE IF NOT EXISTS supplier_payments (
  id            SERIAL PRIMARY KEY,
  due_id        INTEGER NOT NULL UNIQUE REFERENCES supplier_dues(id) ON DELETE CASCADE,
  paid_on       DATE NOT NULL,
  amount_cents  INTEGER NOT NULL,
  file_id       INTEGER REFERENCES supplier_files(id) ON DELETE SET NULL,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PDF subidos para analizar y aún sin confirmar (se borran a las 24 h).
CREATE TABLE IF NOT EXISTS supplier_uploads (
  temp_id     UUID PRIMARY KEY,
  filename    TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  data        BYTEA NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===================== Quién vende =====================
-- Solo quien vende en tienda entra en las ventas por empleado y en los turnos.
-- Iván administra pero no vende: al crear la columna se le marca como «no vende»
-- (una sola vez; luego se cambia desde Admin › Usuarios › Editar).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_seller') THEN
    ALTER TABLE users ADD COLUMN is_seller BOOLEAN NOT NULL DEFAULT TRUE;
    UPDATE users SET is_seller = FALSE WHERE lower(username) = 'ifebles' OR lower(email) = 'ivan.febles@gmail.com';
  END IF;
END $$;

-- ===================== Caja diaria =====================
-- Hasta que el TPV registre cada ticket, las ventas se apuntan por día, turno
-- y método (importe y clientes), a mano o importadas de la app antigua.
CREATE TABLE IF NOT EXISTS sales_days (
  day             DATE PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto', 'festivo', 'cerrado')),
  extended_hours  BOOLEAN NOT NULL DEFAULT FALSE,
  legacy_id       INTEGER UNIQUE,
  updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_sales (
  day           DATE NOT NULL REFERENCES sales_days(day) ON DELETE CASCADE,
  shift         TEXT NOT NULL CHECK (shift IN ('manana', 'tarde')),
  method        TEXT NOT NULL CHECK (method IN ('efectivo', 'tarjeta', 'bizum', 'bonos', 'vales')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  customers     INTEGER NOT NULL DEFAULT 0 CHECK (customers >= 0),
  PRIMARY KEY (day, shift, method)
);

-- Gastos traídos de otra app: recuerdan su id de origen para no duplicarse.
ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS legacy_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS recurring_expenses_legacy_ref_key ON recurring_expenses(legacy_ref) WHERE legacy_ref IS NOT NULL;
