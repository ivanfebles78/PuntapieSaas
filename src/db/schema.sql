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

-- ===================== Stock =====================
-- Tipos de producto, editables en Admin › Catálogo. `size_classes` dice qué
-- tallas admite cada uno (las clases están en src/stock/tipos.js) y
-- `color_required` si el color es obligatorio. La clave no cambia nunca.
CREATE TABLE IF NOT EXISTS product_types (
  key             TEXT PRIMARY KEY CHECK (key ~ '^[a-z0-9-]{1,30}$'),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  size_classes    TEXT[] NOT NULL CHECK (cardinality(size_classes) > 0),
  color_required  BOOLEAN NOT NULL DEFAULT TRUE,
  position        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS product_types_name_key ON product_types (lower(name));
-- Los de partida, solo la primera vez: lo que se borre o renombre en Admin no vuelve.
INSERT INTO product_types (key, name, size_classes, color_required, position)
SELECT * FROM (VALUES
  ('calzado', 'Calzado', '{numero}'::text[], TRUE, 1),
  ('ropa', 'Ropa', '{letra,edad,rango,ropa,unica}'::text[], TRUE, 2),
  ('accesorios', 'Accesorios', '{unica,letra}'::text[], TRUE, 3),
  ('juguetes', 'Juguetes', '{unica}'::text[], FALSE, 4)
) AS v(key, name, size_classes, color_required, position)
WHERE NOT EXISTS (SELECT 1 FROM product_types)
ON CONFLICT DO NOTHING;

-- Subtipos de producto dentro de cada tipo.
CREATE TABLE IF NOT EXISTS product_subtypes (
  id    SERIAL PRIMARY KEY,
  type  TEXT NOT NULL REFERENCES product_types(key) ON DELETE CASCADE,
  name  TEXT NOT NULL,
  UNIQUE (type, name)
);
-- Antes el tipo era una lista fija: pasa a la tabla de tipos.
ALTER TABLE product_subtypes DROP CONSTRAINT IF EXISTS product_subtypes_type_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_subtypes_type_fkey') THEN
    ALTER TABLE product_subtypes ADD CONSTRAINT product_subtypes_type_fkey FOREIGN KEY (type) REFERENCES product_types(key) ON DELETE CASCADE;
  END IF;
END $$;

-- Igual: los subtipos de partida solo con la tabla vacía (y de tipos que existan).
INSERT INTO product_subtypes (type, name)
SELECT v.type, v.name FROM (VALUES
  ('calzado', 'Tenis'), ('calzado', 'Zapatos'), ('calzado', 'Escolares'), ('calzado', 'Sandalias'), ('calzado', 'Botas'),
  ('ropa', 'Calcetines'), ('ropa', 'Pijamas'), ('ropa', 'Chubasqueros'), ('ropa', 'Bañadores'),
  ('accesorios', 'Mochilas'), ('accesorios', 'Paraguas'), ('accesorios', 'Botellas'), ('accesorios', 'Estuches'),
  ('juguetes', 'Juegos de mesa'), ('juguetes', 'Yoyós'), ('juguetes', 'Juegos de cartas')
) AS v(type, name)
JOIN product_types t ON t.key = v.type
WHERE NOT EXISTS (SELECT 1 FROM product_subtypes)
ON CONFLICT DO NOTHING;

-- Un artículo por SKU (marca + modelo + referencia + color + talla) con su
-- código de barras EAN-13, como el inventario de la web antigua. `stock` es lo
-- disponible en tienda; lo que viene en camino está en inventory_incoming.
-- La talla es texto («27», «M», «4A», «Única») y `size_order` la ordena.
CREATE TABLE IF NOT EXISTS inventory_items (
  id                SERIAL PRIMARY KEY,
  brand             TEXT NOT NULL,
  model             TEXT NOT NULL,
  reference         TEXT NOT NULL,
  color             TEXT NOT NULL,
  size              TEXT NOT NULL DEFAULT 'Única',
  barcode           TEXT NOT NULL UNIQUE,
  stock             INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  sale_price_cents  INTEGER CHECK (sale_price_cents >= 0),
  cost_cents        INTEGER CHECK (cost_cents >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (brand, model, reference, color, size)
);

-- La talla era un número (0 = sin talla): pasa a texto conservando el orden.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'inventory_items' AND column_name = 'size') = 'smallint' THEN
    ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_size_check;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS size_order NUMERIC(6, 1);
    UPDATE inventory_items SET size_order = CASE WHEN size = 0 THEN 1000 ELSE size END;
    ALTER TABLE inventory_items ALTER COLUMN size DROP DEFAULT;
    ALTER TABLE inventory_items ALTER COLUMN size TYPE TEXT USING CASE WHEN size = 0 THEN 'Única' ELSE size::text END;
    ALTER TABLE inventory_items ALTER COLUMN size SET DEFAULT 'Única';
  END IF;
END $$;

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS size_order NUMERIC(6, 1);
UPDATE inventory_items SET size_order = 1000 WHERE size_order IS NULL;
ALTER TABLE inventory_items ALTER COLUMN size_order SET DEFAULT 1000;
ALTER TABLE inventory_items ALTER COLUMN size_order SET NOT NULL;
-- Lo que ya había es calzado; el tipo y el subtipo se pueden cambiar en Inventario.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'calzado';
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_type_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_type_fkey') THEN
    ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_type_fkey FOREIGN KEY (type) REFERENCES product_types(key) ON DELETE RESTRICT;
  END IF;
END $$;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS subtype_id INTEGER REFERENCES product_subtypes(id) ON DELETE SET NULL;
-- Detalle: lo que explica el producto (suele venir en la descripción de la factura).
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS detail TEXT NOT NULL DEFAULT '';
-- Código de barras de fábrica, opcional: escanear la caja original también lo encuentra.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS maker_barcode TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_maker_barcode_key ON inventory_items(maker_barcode) WHERE maker_barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_items_reference_idx ON inventory_items(reference);
CREATE INDEX IF NOT EXISTS inventory_items_brand_lower_idx ON inventory_items (lower(brand));

-- Fabricantes del catálogo (Admin › Catálogo) y para qué tipos y subtipos se
-- ofrecen al dar de alta un producto. Sin ámbitos = para todos los tipos; un
-- ámbito sin subtipo = todo ese tipo. El inventario guarda el nombre (texto).
CREATE TABLE IF NOT EXISTS product_brands (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 50)
);
CREATE UNIQUE INDEX IF NOT EXISTS product_brands_name_key ON product_brands (lower(name));
CREATE TABLE IF NOT EXISTS product_brand_scopes (
  id          SERIAL PRIMARY KEY,
  brand_id    INTEGER NOT NULL REFERENCES product_brands(id) ON DELETE CASCADE,
  type        TEXT NOT NULL REFERENCES product_types(key) ON DELETE CASCADE,
  subtype_id  INTEGER REFERENCES product_subtypes(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS product_brand_scopes_key ON product_brand_scopes (brand_id, type, COALESCE(subtype_id, 0));
-- Los fabricantes que ya hay en el inventario entran solos, con los tipos de sus productos.
WITH nuevas AS (
  INSERT INTO product_brands (name)
  SELECT DISTINCT ON (lower(i.brand)) i.brand FROM inventory_items i
  WHERE length(i.brand) BETWEEN 1 AND 50
    AND NOT EXISTS (SELECT 1 FROM product_brands b WHERE lower(b.name) = lower(i.brand))
  GROUP BY i.brand
  ORDER BY lower(i.brand), count(*) DESC, i.brand
  ON CONFLICT DO NOTHING
  RETURNING id, name
)
INSERT INTO product_brand_scopes (brand_id, type)
SELECT DISTINCT n.id, i.type FROM nuevas n JOIN inventory_items i ON lower(i.brand) = lower(n.name)
ON CONFLICT DO NOTHING;

-- Mercancía de un pedido o factura: «pendiente» hasta que llega a la tienda.
-- Al recibirla, lo recibido suma al stock; lo que no llega queda como «falta»
-- (para reclamar) hasta que llega o se anula.
CREATE TABLE IF NOT EXISTS inventory_incoming (
  id            SERIAL PRIMARY KEY,
  doc_id        INTEGER NOT NULL REFERENCES supplier_docs(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  received_qty  INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  state         TEXT NOT NULL DEFAULT 'pendiente' CHECK (state IN ('pendiente', 'recibido', 'falta', 'anulado')),
  received_at   TIMESTAMPTZ,
  received_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (received_qty <= quantity)
);

CREATE INDEX IF NOT EXISTS inventory_incoming_doc_idx ON inventory_incoming(doc_id);
CREATE INDEX IF NOT EXISTS inventory_incoming_item_idx ON inventory_incoming(item_id);
CREATE INDEX IF NOT EXISTS inventory_incoming_state_idx ON inventory_incoming(state);

-- Proveedor al que se compra cada fabricante (Condor → Aretex...). Al crear la
-- columna, una sola vez, se rellena con el proveedor de sus pedidos y facturas
-- cuando todos son del mismo; luego se cambia en Admin › Catálogo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'product_brands' AND column_name = 'supplier_id') THEN
    ALTER TABLE product_brands ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;
    UPDATE product_brands b SET supplier_id = x.supplier_id
      FROM (SELECT lower(a.brand) AS marca, min(d.supplier_id) AS supplier_id
              FROM inventory_incoming ii
              JOIN inventory_items a ON a.id = ii.item_id
              JOIN supplier_docs d ON d.id = ii.doc_id
             GROUP BY lower(a.brand) HAVING count(DISTINCT d.supplier_id) = 1) x
     WHERE lower(b.name) = x.marca;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS product_brands_supplier_idx ON product_brands(supplier_id);

-- ===================== Correo =====================
-- Revisión diaria del buzón: cada ejecución, los correos ya vistos (para no
-- procesarlos dos veces) y sus PDF. Un PDF que no se registra solo queda
-- «revisar» con su contenido, para confirmarlo a mano en «Importar PDF».
CREATE TABLE IF NOT EXISTS mail_runs (
  id           SERIAL PRIMARY KEY,
  origin       TEXT NOT NULL CHECK (origin IN ('auto', 'manual')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  summary      JSONB,
  error        TEXT,
  started_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mail_messages (
  id           SERIAL PRIMARY KEY,
  message_id   TEXT NOT NULL UNIQUE,
  uid          BIGINT,
  from_addr    TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  sent_at      TIMESTAMPTZ,
  marked_read  BOOLEAN NOT NULL DEFAULT FALSE,
  run_id       INTEGER REFERENCES mail_runs(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mail_attachments (
  id           SERIAL PRIMARY KEY,
  message_ref  INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  -- proveedor (factura/pedido), gasto (recurrente) o desconocido
  kind         TEXT NOT NULL CHECK (kind IN ('proveedor', 'gasto', 'desconocido')),
  -- creado: registrado solo · productos: factura creada, faltan sus productos ·
  -- revisar: hay que confirmarlo · ignorado: no hacía falta · hecho/descartado: resuelto a mano
  state        TEXT NOT NULL CHECK (state IN ('creado', 'productos', 'revisar', 'ignorado', 'hecho', 'descartado')),
  reason       TEXT NOT NULL DEFAULT '',
  doc_id       INTEGER REFERENCES supplier_docs(id) ON DELETE SET NULL,
  expense_id   INTEGER REFERENCES recurring_expenses(id) ON DELETE SET NULL,
  month        DATE,
  data         BYTEA,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mail_attachments_state_idx ON mail_attachments(state);
CREATE INDEX IF NOT EXISTS mail_attachments_sha_idx ON mail_attachments(sha256);

-- Cuándo se marcó como leído cada correo (historial del asistente en Admin).
-- Los marcados antes de existir la columna toman la hora en que se procesaron.
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
UPDATE mail_messages SET read_at = created_at WHERE marked_read AND read_at IS NULL;
CREATE INDEX IF NOT EXISTS mail_messages_sent_idx ON mail_messages(sent_at DESC);
-- Los extractos del datáfono (resumen@…) no son facturas: lo que quedó para
-- revisar antes de ignorarlos pasa a descartado.
UPDATE mail_attachments a
   SET state = 'descartado', reason = 'Extracto del datáfono (no es una factura): se ignora', resolved_at = NOW(), data = NULL
  FROM mail_messages m
 WHERE a.message_ref = m.id AND a.state IN ('revisar', 'productos') AND m.from_addr ILIKE 'resumen@%';

-- ===================== TPV: ventas =====================
-- Un ticket por venta, con sus líneas (artículo del stock o libre) y sus
-- pagos (se puede repartir entre varios métodos). Cada pago se apunta también
-- en `sales`, que es lo que leen las estadísticas.
CREATE TABLE IF NOT EXISTS tpv_discount_requests (
  id            SERIAL PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  requested_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Cómo se pide: en persona (usuario y contraseña del admin) o a distancia (WhatsApp).
  channel       TEXT NOT NULL CHECK (channel IN ('presencial', 'whatsapp')),
  percent       NUMERIC(5, 2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  total_cents   INTEGER NOT NULL CHECK (total_cents >= 0),
  summary       JSONB NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'aprobado', 'rechazado', 'usado', 'caducado')),
  decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  notified      TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS tpv_tickets (
  id              SERIAL PRIMARY KEY,
  year            SMALLINT NOT NULL,
  seq             INTEGER NOT NULL,
  number          TEXT NOT NULL UNIQUE,
  sold_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  subtotal_cents  INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents  INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents     INTEGER NOT NULL CHECK (total_cents >= 0),
  change_cents    INTEGER NOT NULL DEFAULT 0 CHECK (change_cents >= 0),
  approval_id     INTEGER REFERENCES tpv_discount_requests(id) ON DELETE SET NULL,
  seller_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  seller_name     TEXT NOT NULL DEFAULT '',
  UNIQUE (year, seq)
);

CREATE TABLE IF NOT EXISTS tpv_ticket_lines (
  id              SERIAL PRIMARY KEY,
  ticket_id       INTEGER NOT NULL REFERENCES tpv_tickets(id) ON DELETE CASCADE,
  position        SMALLINT NOT NULL,
  item_id         INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  barcode         TEXT,
  size            TEXT,
  type            TEXT,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  unit_cents      INTEGER NOT NULL CHECK (unit_cents >= 0),
  discount_cents  INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents     INTEGER NOT NULL CHECK (total_cents >= 0),
  cost_cents      INTEGER,
  without_stock   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS tpv_ticket_payments (
  id              SERIAL PRIMARY KEY,
  ticket_id       INTEGER NOT NULL REFERENCES tpv_tickets(id) ON DELETE CASCADE,
  method          TEXT NOT NULL CHECK (method IN ('efectivo', 'tarjeta', 'bizum', 'bonos', 'vales')),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  tendered_cents  INTEGER
);

CREATE INDEX IF NOT EXISTS tpv_ticket_lines_ticket_idx ON tpv_ticket_lines(ticket_id);
CREATE INDEX IF NOT EXISTS tpv_ticket_payments_ticket_idx ON tpv_ticket_payments(ticket_id);
CREATE INDEX IF NOT EXISTS tpv_tickets_sold_idx ON tpv_tickets(sold_at);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tpv_tickets(id) ON DELETE CASCADE;

-- ===================== TPV: caja (apertura, movimientos y arqueo) =====================
-- Una sesión de caja de la apertura al cierre. Se cuenta el dinero por
-- monedas y billetes al abrir y al cerrar; al cerrar, lo contado debe ser
-- inicial + efectivo de las ventas + entradas − salidas. Si no cuadra, el
-- cierre necesita la aprobación de un Administrador. Solo una caja abierta.
CREATE TABLE IF NOT EXISTS tpv_cash_sessions (
  id               SERIAL PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta', 'cerrada')),
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opening_counts   JSONB NOT NULL DEFAULT '{}',
  opening_cents    INTEGER NOT NULL CHECK (opening_cents >= 0),
  closed_at        TIMESTAMPTZ,
  closed_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closing_counts   JSONB,
  closing_cents    INTEGER,
  expected_cents   INTEGER,
  difference_cents INTEGER,
  approval_id      INTEGER REFERENCES tpv_discount_requests(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tpv_cash_sessions_open_key ON tpv_cash_sessions((status)) WHERE status = 'abierta';

CREATE TABLE IF NOT EXISTS tpv_cash_moves (
  id           SERIAL PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES tpv_cash_sessions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('entrada', 'salida')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  concept      TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tpv_cash_moves_session_idx ON tpv_cash_moves(session_id);
ALTER TABLE tpv_tickets ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES tpv_cash_sessions(id) ON DELETE SET NULL;

-- Las aprobaciones sirven para descuentos y para cierres de caja que no cuadran.
ALTER TABLE tpv_discount_requests ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'descuento';
ALTER TABLE tpv_discount_requests DROP CONSTRAINT IF EXISTS tpv_discount_requests_kind_check;
ALTER TABLE tpv_discount_requests ADD CONSTRAINT tpv_discount_requests_kind_check CHECK (kind IN ('descuento', 'cierre', 'cambio'));
ALTER TABLE tpv_discount_requests ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES tpv_cash_sessions(id) ON DELETE CASCADE;
ALTER TABLE tpv_discount_requests DROP CONSTRAINT IF EXISTS tpv_discount_requests_percent_check;
ALTER TABLE tpv_discount_requests ADD CONSTRAINT tpv_discount_requests_percent_check CHECK (percent >= 0 AND percent <= 100);

-- ===================== TPV: cambios y vales =====================
-- Un cambio es un ticket de tipo «cambio»: lo devuelto (que vuelve al stock)
-- se descuenta de lo nuevo que se lleva. Si lo nuevo vale más, se paga la
-- diferencia; si vale menos (o no se lleva nada), el resto va a un vale.
-- No se devuelve dinero.
ALTER TABLE tpv_tickets ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'venta';
ALTER TABLE tpv_tickets DROP CONSTRAINT IF EXISTS tpv_tickets_kind_check;
ALTER TABLE tpv_tickets ADD CONSTRAINT tpv_tickets_kind_check CHECK (kind IN ('venta', 'cambio', 'rectificativa'));
ALTER TABLE tpv_tickets ADD COLUMN IF NOT EXISTS credit_cents INTEGER NOT NULL DEFAULT 0;

-- Vale: un código (va en el QR), importe, saldo y caducidad (1 año). Se puede
-- gastar en varias compras hasta agotar el saldo.
CREATE TABLE IF NOT EXISTS tpv_vouchers (
  id               SERIAL PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_on       DATE NOT NULL,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  balance_cents    INTEGER NOT NULL CHECK (balance_cents >= 0),
  origin_ticket_id INTEGER REFERENCES tpv_tickets(id) ON DELETE SET NULL,
  issued_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CHECK (balance_cents <= amount_cents)
);

CREATE TABLE IF NOT EXISTS tpv_voucher_uses (
  id           SERIAL PRIMARY KEY,
  voucher_id   INTEGER NOT NULL REFERENCES tpv_vouchers(id) ON DELETE CASCADE,
  ticket_id    INTEGER NOT NULL REFERENCES tpv_tickets(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tpv_voucher_uses_voucher_idx ON tpv_voucher_uses(voucher_id);
ALTER TABLE tpv_ticket_payments ADD COLUMN IF NOT EXISTS voucher_id INTEGER REFERENCES tpv_vouchers(id) ON DELETE SET NULL;

-- Lo devuelto en un cambio: de qué venta del TPV sale (o el importe del ticket
-- de papel, con aprobación) y cuánto se le reconoce.
CREATE TABLE IF NOT EXISTS tpv_return_lines (
  id                SERIAL PRIMARY KEY,
  ticket_id         INTEGER NOT NULL REFERENCES tpv_tickets(id) ON DELETE CASCADE,
  item_id           INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
  sold_line_id      INTEGER REFERENCES tpv_ticket_lines(id) ON DELETE SET NULL,
  description       TEXT NOT NULL,
  size              TEXT,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  credit_cents      INTEGER NOT NULL CHECK (credit_cents >= 0),
  paper_ticket      TEXT,
  sold_on           DATE
);

CREATE INDEX IF NOT EXISTS tpv_return_lines_sold_idx ON tpv_return_lines(sold_line_id);

ALTER TABLE tpv_discount_requests DROP CONSTRAINT IF EXISTS tpv_discount_requests_kind_check;
ALTER TABLE tpv_discount_requests ADD CONSTRAINT tpv_discount_requests_kind_check CHECK (kind IN ('descuento', 'cierre', 'cambio'));

-- ===================== TPV: serie rectificativa =====================
-- Cada devolución es una factura rectificativa en su propia serie (R26-…)
-- con lo devuelto (importe en positivo, resta en las ventas). Lo nuevo que se
-- lleva es una venta normal (T26-…) que se paga en parte con ese «abono»; si
-- sobra, el resto va a un vale. Los tickets «cambio» antiguos se siguen leyendo.
ALTER TABLE tpv_tickets ADD COLUMN IF NOT EXISTS series TEXT NOT NULL DEFAULT 'T';
ALTER TABLE tpv_tickets DROP CONSTRAINT IF EXISTS tpv_tickets_series_check;
ALTER TABLE tpv_tickets ADD CONSTRAINT tpv_tickets_series_check CHECK (series IN ('T', 'R'));
ALTER TABLE tpv_tickets DROP CONSTRAINT IF EXISTS tpv_tickets_kind_check;
ALTER TABLE tpv_tickets ADD CONSTRAINT tpv_tickets_kind_check CHECK (kind IN ('venta', 'cambio', 'rectificativa'));
-- En una venta pagada con abono: la rectificativa de la que sale.
ALTER TABLE tpv_tickets ADD COLUMN IF NOT EXISTS credit_from_id INTEGER REFERENCES tpv_tickets(id) ON DELETE SET NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tpv_tickets_series_year_seq_key') THEN
    ALTER TABLE tpv_tickets DROP CONSTRAINT IF EXISTS tpv_tickets_year_seq_key;
    ALTER TABLE tpv_tickets ADD CONSTRAINT tpv_tickets_series_year_seq_key UNIQUE (series, year, seq);
  END IF;
END $$;
ALTER TABLE tpv_ticket_payments DROP CONSTRAINT IF EXISTS tpv_ticket_payments_method_check;
ALTER TABLE tpv_ticket_payments ADD CONSTRAINT tpv_ticket_payments_method_check
  CHECK (method IN ('efectivo', 'tarjeta', 'bizum', 'bonos', 'vales', 'abono'));
ALTER TABLE tpv_ticket_payments ADD COLUMN IF NOT EXISTS credit_ticket_id INTEGER REFERENCES tpv_tickets(id) ON DELETE SET NULL;

-- ===================== TPV: defectuosos, cuarentena y garantías =====================
-- Al devolver, cada producto vuelve al stock («stock», en buen estado) o es
-- «defectuoso»: no vuelve a la venta, queda en cuarentena y abre una
-- incidencia de garantía con fotos y su proveedor. La garantía legal no se
-- limita a los 30 días de la política de cambios y, en un defectuoso, el
-- cliente puede elegir que se le devuelva el dinero en vez de un vale.
ALTER TABLE tpv_return_lines ADD COLUMN IF NOT EXISTS condition TEXT NOT NULL DEFAULT 'stock';
ALTER TABLE tpv_return_lines DROP CONSTRAINT IF EXISTS tpv_return_lines_condition_check;
ALTER TABLE tpv_return_lines ADD CONSTRAINT tpv_return_lines_condition_check CHECK (condition IN ('stock', 'defectuoso'));
-- Dinero devuelto al cliente en una rectificativa (solo por defectuosos).
ALTER TABLE tpv_tickets ADD COLUMN IF NOT EXISTS refund_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tpv_tickets ADD COLUMN IF NOT EXISTS refund_method TEXT;
ALTER TABLE tpv_tickets DROP CONSTRAINT IF EXISTS tpv_tickets_refund_check;
ALTER TABLE tpv_tickets ADD CONSTRAINT tpv_tickets_refund_check CHECK (
  refund_cents >= 0 AND ((refund_cents = 0 AND refund_method IS NULL) OR (refund_cents > 0 AND refund_method IN ('efectivo', 'tarjeta', 'bizum'))));

-- Incidencia de garantía: abierta (en cuarentena) → reclamada al proveedor →
-- resuelta. Lo que pasa con el cliente ya quedó en la rectificativa; aquí va
-- la respuesta del proveedor: abono, sustitución (vuelve al stock), reembolso,
-- rechazo, o «a_stock» si al final el producto se puede vender.
CREATE TABLE IF NOT EXISTS warranty_cases (
  id                SERIAL PRIMARY KEY,
  return_line_id    INTEGER UNIQUE REFERENCES tpv_return_lines(id) ON DELETE SET NULL,
  ticket_id         INTEGER REFERENCES tpv_tickets(id) ON DELETE SET NULL,
  item_id           INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
  supplier_id       INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  description       TEXT NOT NULL,
  size              TEXT,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  credit_cents      INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  defect            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta', 'reclamada', 'resuelta')),
  claim_ref         TEXT,
  claim_notes       TEXT,
  claimed_at        TIMESTAMPTZ,
  claimed_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution        TEXT CHECK (resolution IN ('abono', 'sustitucion', 'reembolso', 'rechazada', 'a_stock')),
  resolution_cents  INTEGER CHECK (resolution_cents >= 0),
  resolution_notes  TEXT,
  resolved_at       TIMESTAMPTZ,
  resolved_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'resuelta') = (resolution IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS warranty_cases_status_idx ON warranty_cases(status);
CREATE INDEX IF NOT EXISTS warranty_cases_item_idx ON warranty_cases(item_id);

-- Una aprobación de cambio vale solo para lo que se aprobó (líneas, estado y dinero devuelto).
ALTER TABLE tpv_discount_requests ADD COLUMN IF NOT EXISTS fingerprint TEXT;

-- Fotos y documentos de la incidencia (la del defecto, la respuesta del proveedor…).
CREATE TABLE IF NOT EXISTS warranty_files (
  id          SERIAL PRIMARY KEY,
  case_id     INTEGER NOT NULL REFERENCES warranty_cases(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  data        BYTEA NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS warranty_files_case_idx ON warranty_files(case_id);

-- ===================== TPV: reservas (apartados sin pagar) =====================
-- Un cliente aparta uno o varios productos sin pagar, como mucho TPV_RESERVA_DIAS
-- días. Lo reservado no sale del stock físico: resta de lo disponible para vender
-- mientras la reserva está activa y no ha vencido. Al vencer se libera sola; la
-- tarea de limpieza la marca «caducada». Del cliente solo se guarda un nombre y,
-- si quiere, un teléfono para avisarle; se borran 30 días después de cerrarla.
CREATE TABLE IF NOT EXISTS tpv_reservations (
  id             SERIAL PRIMARY KEY,
  customer_name  TEXT NOT NULL,
  phone          TEXT,
  notes          TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'activa' CHECK (status IN ('activa', 'vendida', 'cancelada', 'caducada')),
  expires_at     TIMESTAMPTZ NOT NULL,
  extensions     SMALLINT NOT NULL DEFAULT 0,
  ticket_id      INTEGER REFERENCES tpv_tickets(id) ON DELETE SET NULL,
  cancel_reason  TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at      TIMESTAMPTZ,
  contact_erased BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK ((status = 'activa') = (closed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS tpv_reservation_lines (
  id              SERIAL PRIMARY KEY,
  reservation_id  INTEGER NOT NULL REFERENCES tpv_reservations(id) ON DELETE CASCADE,
  item_id         INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  UNIQUE (reservation_id, item_id)
);

CREATE INDEX IF NOT EXISTS tpv_reservations_status_idx ON tpv_reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS tpv_reservation_lines_item_idx ON tpv_reservation_lines(item_id);
