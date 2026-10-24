# Puntapié · Gestión

Aplicación única de gestión interna de Puntapié (calzado infantil, Santa Cruz de Tenerife).
Irá reuniendo los módulos que hoy viven por separado: **gastos y ventas, facturas, CRM y administración**.

**Fase actual:** portada con la foto de la tienda + acceso (iniciar sesión, mostrar/ocultar
contraseña y recuperación de contraseña por correo). Roles y módulos llegarán después.

## Stack

- Node 22 · Express 5 · PostgreSQL (`pg`, sin ORM)
- Frontend estático sin build (`public/`: HTML + CSS + JS módulo)
- Esquema SQL idempotente (`src/db/schema.sql`) aplicado en cada arranque
- Un único servicio Docker (Railway), healthcheck en `/api/health`

## Roles y equipo

| Rol | Qué ve |
|---|---|
| **Administrador** (`admin`) | Todo, incluido el módulo Admin (gestión del equipo) |
| **Asesor** (`asesor`) | Todo (también Admin y las estadísticas por empleado), pero **solo consulta**: el servidor rechaza cualquier cambio (403 `READ_ONLY`); sí puede exportar |
| **Empleado** (`empleado`) | Vista limitada; se definirá módulo a módulo |

- Se entra con **nombre de usuario o correo**.
- Cuentas iniciales (en `src/db/seed-team.js`, contraseña inicial hasheada, cambio obligatorio
  en el primer acceso): `ctoriz` Claudia (admin), `epena` Elena (empleado),
  `rperez` Raquel (empleado), `ifebles` Iván (admin). Además, `ivan.febles@gmail.com` (admin).
- **Admin › Usuarios**: lista con filtros y búsqueda, invitar por correo (enlace de 7 días para
  crear la contraseña), cambiar rol, editar nombre/correo, dar de baja/reactivar, enviar enlace de
  contraseña o, si no tiene correo, generar una contraseña provisional, y **vacaciones** de cada
  persona (periodos sin solapes, días naturales, aviso «De vacaciones hasta…» en su fila) con
  **saldo del año**: 30 días naturales, o la parte proporcional (al alza) si el contrato empezó
  durante el año (p. ej. 07/07 → 15), menos los disfrutados (hasta hoy) y los programados. Los días no usados antes del 31 de
  diciembre **se pierden**: no pasan al año siguiente.
- **Turno** de cada persona: mañana (10:00–13:30) y/o tarde (16:30–20:00) de lunes a viernes y
  sábado por la mañana, con fecha «válido desde» (historial: cambiar el turno no altera los días
  anteriores).
- **Admin › Aperturas extra**: sábados por la tarde (16:30–20:00) y domingos por la mañana
  (10:00–13:30) que se abren de forma puntual, un día o todos los de un mes, con quién trabaja.
  Cada turno extra (3,5 h) da **7 h de descanso** (2 h por hora) cuando el día ha pasado.
- **Horas bonificadas** (dentro de Vacaciones, aparte de los días naturales): ganadas, por ganar,
  usadas y disponibles. Se gastan pidiendo **turnos libres** de 3,5 h en turnos que la persona
  trabaja (un día entero entre semana = 2 turnos). No se puede quitar una apertura cuyas horas ya
  se gastaron.
- **Admin › Log de acciones**: cada acción (accesos, fallidos incluidos, usuarios, vacaciones,
  turnos, aperturas, horas, gastos, documentos, objetivos y exportaciones) con fecha y hora,
  usuario, sección, acción, sobre qué, campo, valor anterior y nuevo. Filtros por usuario,
  sección, acción, fechas y texto; nunca guarda contraseñas.
- Protecciones: nadie cambia su propio rol ni se da de baja, y siempre queda un Administrador activo.
  La API exige el rol en el servidor (`/api/admin/*` → 403 para Empleado; escrituras → 403 para Asesor).

## Gastos (una sola tabla)

- Sin submenús: `/app/gastos?mes=AAAA-MM` (o `?desde=AAAA-MM&hasta=AAAA-MM`, hasta 24 meses).
- Cada gasto lleva su **tipo** con color: **Recurrente** (azul), **Proveedor** (violeta) y
  **Esporádico** (mostaza). El total del mes suma los tres y se desglosa por tipo.
- Filtros: tipo, estado (pendiente/pagado), texto del concepto e importe mínimo/máximo; los totales
  se recalculan con lo filtrado.
- **Recurrente fijo**: su importe se repite cada mes; se cambia **solo un mes** o **desde un mes en
  adelante**. **Recurrente variable**: empieza cada mes en 0.
- **Esporádico**: un único pago con su fecha e importe.
- **Proveedor**: las facturas de proveedor salen **cuando hay que pagarlas**: una fila por
  vencimiento, en el mes de su fecha y con su importe (una factura de agosto que se paga en
  noviembre y diciembre sale en esos dos meses), con el PDF, el justificante de ese pago y su
  estado; el filtro «Proveedores» las muestra. No se apuntan a mano: se gestionan en **«Gestionar pagos a proveedores»** (ver abajo).
- Facturas y justificantes (PDF o imagen, hasta 10 MB, varios). Subir un justificante deja el gasto
  **pagado**; borrar el último lo devuelve a **pendiente**. El estado también se cambia a mano.
- Los documentos se guardan en PostgreSQL (el disco de Railway se borra en cada despliegue).
- **Exportar**: ZIP con un Excel (todos los movimientos y resumen por mes, con enlaces a cada
  documento) y las carpetas `facturas/` y `justificantes/` por mes y concepto; del periodo en
  pantalla o de todo el historial.

## Pagos a proveedores (antes «Control de facturas»)

Migrado de la app FacturasPuntaPie. Botón **«Gestionar pagos a proveedores»** en Gastos: un modal
con lo mismo que tenía la app original.

- **Facturas**: tarjetas (pendiente, vence en 7 días, vencido, pagado, pedidos abiertos), filtros por
  proveedor, estado y texto, tabla con vencimientos de colores (rojo ≤ 7 días, morado vencido) y
  totales de lo filtrado; CSV.
- **Detalle**: pagar un vencimiento o toda la factura con justificante, anular pagos, adjuntar o
  sustituir el PDF y los justificantes, editar datos y vencimientos (los pagos se conservan si no
  cambian fecha e importe), asociar factura ↔ pedido y eliminar.
- **Previsión**: vencido + 3, 6 o 12 meses, con «pagado con/sin justificante» en cada línea, y
  **calendario de pagos en PDF** (3, 6 o 9 meses).
- **Pedidos**: «facturado» automático cuando una factura cita su número; recibido / cancelado.
- **Proveedores**: se crean solos por CIF al importar; renombrar y CIF.
- **Importar PDF**: hasta 30 PDF; 8 lectores por proveedor (Garvalín, Lejan, Pablosky, Titanitos,
  Gioseppo, Condor, Etika, Victoria) y uno genérico; **IA opcional** con `ANTHROPIC_API_KEY`
  (`AI_MODE=auto|always|off`, `AI_MODEL`). Antiduplicados: mismo PDF (SHA-256), mismo número del
  proveedor o misma fecha + importe. Los PDF «envueltos» (cabecera HTTP de la descarga o sobre
  MIME del banco) se limpian solos.
- **Traer los datos de la app antigua** (solo Administrador, en Proveedores): sube el ZIP exportado
  (`datos/datos.json` + `archivos/`). Es idempotente y comprueba que los totales cuadran con
  `datos/resumen.json`.
- Permisos como Gastos: Administrador y Empleado trabajan; el Asesor solo consulta. Todo queda en el
  log. API en `/api/proveedores/*` (mismo contrato que la app original).
- Los tests de los lectores (`lectores.test.js`) y las facturas reales que usan viven en `test/fixtures-proveedores/`, que **no se sube**
  (el repositorio es público): sin esa carpeta, esos tests se saltan.

## Ventas › Caja diaria

Hasta que esté el TPV, las ventas se apuntan por **día, turno y método** (efectivo, tarjeta, Bizum,
bonos consumo y vales) con sus clientes: la **mañana** a mano y, al cerrar, el **total del día del
TPV** por método; la **tarde se calcula** (total − mañana). Festivo o cerrado = sin ventas. Lo
apuntan Administrador y Empleado; el Asesor solo lo ve; todo queda en el log.

- **Importar de la app antigua** (solo Administrador): el ZIP de `gestiondegastos`
  (`ventas_puntapie.json`). No pisa días ya apuntados ni duplica; corrige las erratas de clientes
  que señala `incidencias.csv` («probable error de tecleo, ¿N?»); trae los gastos diarios como
  **esporádicos** salvo los pagos a proveedores («Pago…», «Pedido a…»), que ya están en su gestor.
- Estadísticas usa estos datos: cada turno y método cuenta como ventas con sus clientes (tickets).
  Las **franjas horarias** esperan al TPV (no hay hora).

## Estadísticas (un solo panel)

- `/app/estadisticas?periodo=3m|6m|12m|anio` (y `&simular=1`).
- **Objetivos de venta** editables por el Administrador (por defecto 500 €/día, 3.000 €/semana,
  12.000 €/mes), guardados en la tabla `settings`.
- Por defecto, **Este año**. Nada antes del **16/04/2026** (`BUSINESS_START`): ventas y gastos anteriores eran del dueño anterior. Los **vales** se cuentan aparte y **no suman** a las ventas (salen de
  una devolución de algo ya vendido): no entran en objetivos, medias, turnos ni empleados.
- Ventas de hoy, semana, mes y total del periodo con su avance frente al objetivo; % de días,
  semanas y meses **cerrados** que lo cumplen (los días sin ventas cuentan como cerrados).
- Gráficos: ventas diarias (30 días) y semanales con línea de objetivo, **evolución de ventas y
  gastos mes a mes** (líneas),
  métodos de pago (efectivo, tarjeta, Bizum, bonos consumo, vales), media por día de la semana
  (mejor y más flojo), clientes (tickets) por semana, mañana vs tarde (corte a las 15:00) y ventas
  por franja horaria; además, histórico mensual con beneficio.
- Las ventas salen de la tabla `sales`, que rellenará el TPV. Mientras tanto, **«Simular datos»**
  genera en el servidor ventas y gastos de ejemplo (reproducibles, sin guardar nada).
- Gráficos SVG propios (sin librerías: la CSP no lo permite), con tooltip por ratón y teclado y
  paleta categórica validada para daltonismo.
- Pestaña **Empleados** (Administrador y Asesor). Solo cuenta quien tiene marcado **«Vende en
  tienda»** (Admin › Usuarios › Editar): Iván administra y queda fuera.
  Cómo se atribuye: no se sabe quién cobra cada ticket, pero sí el
  turno y quién estaba (turno fijo − vacaciones − turnos libres + aperturas extra). Cada persona
  suma el total de sus turnos; se compara la **venta media por turno** y un índice frente a la
  media de la tienda en los mismos turnos (la tarde vende más). Vende más / vende menos solo entre
  quienes tienen 5 turnos o más.
- **Exportar** (Administrador y Asesor): ZIP con el Excel de cada ticket (turno y quién estaba),
  resumen por día frente al objetivo y comparativa por empleado.

## Seguridad del acceso

- Contraseñas con bcrypt; sesiones y tokens de recuperación guardados como SHA-256 (nunca en claro).
- Cookie de sesión `httpOnly`, `SameSite=Lax` y `Secure` en producción (30 días).
- Recuperación: respuesta idéntica exista o no la cuenta, enlace de **un solo uso, 60 minutos**;
  pedir uno nuevo anula el anterior y al cambiar la contraseña se cierran todas las sesiones.
- El enlace usa `APP_URL` (o `RAILWAY_PUBLIC_DOMAIN`), nunca la cabecera `Host`.
- Límite de intentos: 20 fallos de login / 15 min por IP (los aciertos no cuentan, la tienda comparte IP)
  y 10 solicitudes de recuperación / 15 min.
- CSP estricta (`style-src 'self'`): nada de estilos inline en el frontend.

## Desarrollo local

```bash
npm install
cp .env.example .env   # rellena DATABASE_URL
npm run dev
```

Sin `RESEND_API_KEY`, el enlace de recuperación se escribe en la consola del servidor.

Tests (necesitan una base de datos vacía de pruebas; la borran y recrean):

```bash
TEST_DATABASE_URL=postgres://usuario@localhost:5432/puntapie_test npm test
```

## Despliegue en Railway

1. Sube el repositorio a GitHub y crea un proyecto en Railway desde el repo (usa el `Dockerfile`).
2. Añade un servicio **PostgreSQL** al proyecto.
3. Variables del servicio web:
   - `DATABASE_URL` → referencia a la del Postgres
   - Nada más es obligatorio: en el primer arranque se crea la cuenta de **Administrador**
     `ivan.febles@gmail.com` con su contraseña ya hasheada con bcrypt en `src/config.js`.
     `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD_HASH` o `ADMIN_INITIAL_PASSWORD` la sustituyen
     antes de ese primer arranque
   - `RESEND_API_KEY` y `MAIL_FROM` para enviar los correos de recuperación
     (el dominio del remitente debe estar verificado en Resend)
   - `APP_URL` si usas un dominio propio (si no, se usa el dominio público de Railway)
4. Genera un dominio público en *Settings → Networking*.

## Imagen de portada

`assets/tienda-original.jpg` es la foto original y `assets/tienda-mejorada.jpg` la versión retocada
(luz, color, nitidez y reescalado ×2, 2304×3072). En `public/img/` están las variantes web
(WebP 900/1600/2400 px y JPG 1600 px de respaldo) que sirve la portada con `srcset`.
