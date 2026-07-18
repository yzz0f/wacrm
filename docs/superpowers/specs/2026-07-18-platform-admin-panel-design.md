# Panel de super-admin de plataforma

**Estado:** Aprobado para plan de implementación
**Fecha:** 2026-07-18
**Alcance:** Sub-proyecto 2 de 2. Depende conceptualmente del sub-proyecto 1 (`docs/superpowers/specs/2026-07-18-multi-number-lines-design.md` — `whatsapp_lines`), pero es una implementación independiente que se puede secuenciar por separado.

## Motivación

wacrm se está preparando para operarse como SaaS multi-cliente desde un solo despliegue. El equipo interno (operador de la plataforma) necesita un panel separado del dashboard normal para ver y administrar todas las cuentas-cliente — soporte, métricas operativas, suspensión — sin que los clientes se vean entre sí ni sepan de la existencia de otras cuentas.

Facturación/planes por cliente sigue explícitamente fuera de alcance (igual que en el sub-proyecto 1).

## Decisiones de producto (confirmadas en brainstorming)

1. **Quién es platform admin**: `profiles.is_platform_admin` (boolean, default `false`). No se toca `profiles.account_id` — un platform admin conserva la cuenta personal que cualquier usuario recibe automáticamente al registrarse; simplemente nunca se usa. Las rutas del panel ignoran `account_id` por completo y solo verifican el flag.
2. **No hay UI de "invitar super-admin"** en esta v1 — se otorga el flag manualmente vía SQL a las primeras cuentas del equipo interno.
3. **Acciones en v1**: ver lista de cuentas + métricas (solo lectura), suspender/reactivar cuenta, editar `whatsapp_lines` de un cliente directamente sin impersonar, impersonación completa, y eliminar cuenta (con período de gracia).
4. **Impersonación**: incluida desde v1, con controles de riesgo:
   - Siempre actúa como el **owner** de la cuenta destino — una cuenta solo puede tener un owner (constraint única existente), así que no hay ambigüedad sobre qué identidad tomar.
   - Acceso completo (como owner real) mientras dura, no solo lectura — necesario para resolver problemas reales de soporte.
   - Expira automáticamente a los **30 minutos**, o el admin sale manualmente antes.
   - Queda registrada en una tabla de auditoría (`impersonation_sessions`) y es **visible para el cliente** en su propio historial de actividad — transparente, sin ser intrusivo (sin email/popup).
5. **Suspensión**: bloquea todo acceso a los datos de la cuenta (vía RLS) sin borrar nada. Reversible.
6. **Eliminación**: de dos pasos. El botón "Eliminar" marca la cuenta como `pending_deletion` con una fecha; un job aparte purga los datos reales 30 días después. Dentro de esa ventana, reactivar la cuenta cancela la eliminación.
7. **Aislamiento técnico**: el panel usa rutas de servidor dedicadas con el cliente de `SUPABASE_SERVICE_ROLE_KEY` (ya existente en el proyecto), **sin modificar ninguna de las ~15 políticas RLS actuales** — cero riesgo de romper el aislamiento de los clientes normales.
8. **Ubicación**: subdominio (`admin.<dominio>`), pero **mismo despliegue** — enrutado por host en el middleware existente, no una segunda aplicación. Así cada quien que auto-hostee wacrm mantiene un solo despliegue.

## Modelo de datos

### `profiles`

- `+ is_platform_admin` (boolean, `NOT NULL DEFAULT false`)

### `accounts`

- `+ status` (enum `account_status`: `active` / `suspended` / `pending_deletion`, default `active`)
- `+ deletion_requested_at` (timestamptz, nullable) — fecha en que se marcó para borrado; el job de purga usa `now() - deletion_requested_at > 30 days` como condición.

### `impersonation_sessions` (nueva tabla)

- `id`, `platform_admin_id` (FK `profiles`), `target_account_id` (FK `accounts`), `target_profile_id` (FK `profiles` — el owner de la cuenta destino), `reason` (text, opcional), `started_at`, `expires_at` (`started_at + 30 min`), `ended_at` (nullable — se completa al salir manualmente o al detectar expiración).
- Es a la vez el log de auditoría del equipo interno y la fuente del aviso visible en la actividad del cliente.

### Suspensión sin tocar políticas individuales

La función `SECURITY DEFINER is_account_member(target_account_id, min_role)` — ya reutilizada por las ~15 políticas RLS existentes — se extiende para además exigir `accounts.status = 'active'`. Una cuenta suspendida queda bloqueada en cada tabla automáticamente, sin editar ni volver a auditar 15 políticas por separado.

## Mecanismo de impersonación

1. El platform admin hace clic en "Actuar como esta cuenta" desde `/platform-admin/accounts/[id]`.
2. El servidor (ruta protegida, service role) crea la fila en `impersonation_sessions` y genera una sesión real de Supabase Auth para el `profile` owner de la cuenta destino, usando el Admin API de Supabase con el service role. *(La llamada exacta del SDK — p. ej. `generateLink`/intercambio de OTP — se verifica contra la versión vigente del SDK al momento de implementar; la API de Supabase evoluciona.)*
3. La identidad original del platform admin se guarda de forma segura (cookie httpOnly aparte, o referenciada por el `id` de la fila en `impersonation_sessions`) para poder restaurarla.
4. El navegador queda con la sesión del owner destino y se redirige al dashboard normal (otro host, `app.<dominio>` o el dominio principal).
5. `dashboard-shell.tsx` (componente existente) detecta la sesión de impersonación activa y muestra un banner persistente: *"Estás actuando como {cuenta} — quedan {mm}:{ss} · Salir"*.
6. Al expirar (30 min) o al hacer clic en "Salir": se completa `ended_at` en `impersonation_sessions` y se restaura la sesión original del platform admin, devolviéndolo a `admin.<dominio>`.
7. El evento queda visible en el historial de actividad de la cuenta cliente (reutilizando el mecanismo existente que alimenta `ActivityFeed`/`loadActivity()` del dashboard — se agrega `impersonation_sessions` como una fuente más de ese feed, igual que hoy se agregan mensajes/deals/broadcasts/automations).

## Routing

- `src/middleware.ts` gana una regla al inicio: si `request.headers.get('host')` coincide con el subdominio admin configurado, reescribe (no redirect) hacia `src/app/platform-admin/*`. Si no, seguir el flujo actual sin cambios — cero impacto en el middleware existente para el tráfico normal.
- Auth: login estándar de Supabase (se reutiliza el componente `LoginPage` existente). Tras autenticar, el middleware verifica `profiles.is_platform_admin = true`; si no lo es, acceso denegado en el propio host de admin — nunca se redirige al dashboard normal (es otro host).
- Todas las rutas de datos viven bajo `/api/platform-admin/*`; cada una revalida `is_platform_admin` en el servidor antes de tocar el cliente con `SUPABASE_SERVICE_ROLE_KEY`.

## UI (reutilizando componentes existentes)

- **`/platform-admin/accounts`** — tabla: nombre de cuenta, correo del owner, estado (badge, mismo patrón visual que otros badges de estado en la app), líneas de WhatsApp, cantidad de miembros, fecha de creación, buscador. Cuentas `pending_deletion` muestran los días restantes.
- **`/platform-admin/accounts/[id]`** — cabecera con estado + acciones (Actuar como esta cuenta / Suspender / Reactivar), tarjetas de métricas (conversaciones, mensajes últimos 30 días, miembros, líneas activas — mismo componente `Card` que ya usa el dashboard normal), lista de líneas de WhatsApp con acceso directo a editarlas sin impersonar, historial de impersonación de esa cuenta, y la acción de eliminar (con período de gracia) al final, visualmente separada como acción destructiva.
- **Banner de impersonación** — nuevo, pero vive dentro de `dashboard-shell.tsx` existente, con el mismo lenguaje visual que el resto de banners de la app (ej. `aiBanner` en Inbox).

## Migración

1. `profiles.is_platform_admin boolean NOT NULL DEFAULT false`.
2. `accounts.status account_status NOT NULL DEFAULT 'active'`, `accounts.deletion_requested_at timestamptz`.
3. Crear tabla `impersonation_sessions`.
4. Extender `is_account_member()` para exigir `status = 'active'` en la cuenta.
5. Otorgar `is_platform_admin = true` manualmente (SQL directo) a las cuentas del equipo interno que correspondan.
6. Job de purga: un proceso programado (idealmente `pg_cron` si el hosting de Supabase lo soporta; si no, una ruta protegida golpeada por un cron externo) que hace `DELETE` en cascada de cuentas con `status = 'pending_deletion'` y `deletion_requested_at` vencido hace más de 30 días.

## Manejo de errores

- Cualquier request a `/api/platform-admin/*` sin `is_platform_admin = true` → `403`, sin importar si está autenticado o no.
- Intentar impersonar una cuenta `suspended` o `pending_deletion` → bloqueado con mensaje explícito (no tiene sentido dar soporte a una cuenta que el propio admin acaba de suspender sin antes reactivarla).
- Reactivar una cuenta `pending_deletion` dentro del período de gracia → limpia `deletion_requested_at` y vuelve a `active`, cancela la purga.
- Sesión de impersonación que expira mientras el admin sigue navegando → la siguiente request server-side detecta `expires_at` vencido, cierra la sesión y redirige a un aviso ("tu sesión de soporte expiró") en vez de dejarlo con una sesión zombie.

## Pruebas

- RLS: una cuenta `suspended` no puede leer ni escribir nada a través de ninguna de las políticas normales (se prueba contra varias tablas, no solo una, dado que todas comparten `is_account_member()`).
- `/api/platform-admin/*` rechaza a cualquier usuario sin `is_platform_admin = true`, incluidos owners/admins de cuentas cliente normales.
- Impersonación: sesión expira a los 30 minutos exactos; el banner se muestra en el dashboard normal; `impersonation_sessions` queda con `ended_at` poblado en ambos casos (expiración natural y salida manual); el evento aparece en la actividad de la cuenta cliente.
- Job de purga: solo elimina cuentas con `pending_deletion` vencido hace más de 30 días — nunca antes, y nunca cuentas `active`/`suspended`.
- Routing por host: una request a `admin.<dominio>` sirve `/platform-admin/*`; la misma ruta en el dominio principal responde 404 (no existe fuera del contexto admin); tráfico normal en el dominio principal no cambia de comportamiento.
