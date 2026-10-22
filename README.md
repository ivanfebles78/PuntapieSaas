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
cp .env.example .env   # rellena DATABASE_URL, ADMIN_EMAIL y ADMIN_INITIAL_PASSWORD
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
   - `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_INITIAL_PASSWORD` (solo se usan para crear la cuenta la primera vez)
   - `RESEND_API_KEY` y `MAIL_FROM` para enviar los correos de recuperación
     (el dominio del remitente debe estar verificado en Resend)
   - `APP_URL` si usas un dominio propio (si no, se usa el dominio público de Railway)
4. Genera un dominio público en *Settings → Networking*.

## Imagen de portada

`assets/tienda-original.jpg` es la foto original y `assets/tienda-mejorada.jpg` la versión retocada
(luz, color, nitidez y reescalado ×2, 2304×3072). En `public/img/` están las variantes web
(WebP 900/1600/2400 px y JPG 1600 px de respaldo) que sirve la portada con `srcset`.
