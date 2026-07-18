# Plan de implementación: Panel de super-admin de plataforma

**Spec:** `docs/superpowers/specs/2026-07-18-platform-admin-panel-design.md`
**Alcance:** Sub-proyecto 2 de 2 del esfuerzo multi-tenant. El sub-proyecto 1 (multi-número/`whatsapp_lines`) ya está implementado por completo — ver `docs/superpowers/plans/2026-07-18-multi-number-lines-plan.md` como referencia de convenciones (no se toca en este plan).

Cada fase está pensada para ejecutarse en una sesión nueva, citando archivo:línea del código real.

---

## Fase 0 — Hechos verificados (referencia, no se ejecuta)

**`src/middleware.ts` (95 líneas, completo):**
- Usa `createServerClient` de `@supabase/ssr` con las claves anon (`:7-24`), NO service role.
- Patrones existentes a reutilizar: `request.nextUrl.clone()` (`:56`, `:75`) para construir una URL modificada; `NextResponse.redirect(url)` (`:69`, `:77`); `NextResponse.json(...)` (`:84`).
- **No existe ningún `NextResponse.rewrite()` en el archivo hoy** — el rewrite por host que pide el spec es un patrón genuinamente nuevo aquí, no una copia.
- Punto de inserción natural: entre la línea 5 (`let supabaseResponse = NextResponse.next({ request })`) y la línea 7 (antes de construir el cliente anon) — la rama de host admin necesita su propia verificación de `is_platform_admin`, no la lógica de `protectedPaths`/`user` de abajo.
- `config.matcher` (`:91-95`) no está limitado por host — ya corre para cualquier request, incluido `admin.<dominio>`. No hace falta tocar el matcher, solo la rama dentro de la función.

**Versiones instaladas (verificado en `node_modules`, no en el rango semver de `package.json`):**
- `@supabase/supabase-js`: **2.110.6**
- `@supabase/ssr`: **0.12.3**
- `@supabase/auth-js` (subyacente): **2.110.6**, en layout pnpm anidado (`node_modules/.pnpm/@supabase+auth-js@2.110.6/...`)

**Mecanismo de impersonación (API real, citada de los `.d.ts` instalados, no de memoria):**
1. `supabase.auth.admin.generateLink({ type: 'magiclink', email })` (`GoTrueAdminApi.d.ts:251`, ejemplo verbatim en `:218-224`) — con el cliente service-role (`supabaseAdmin()`, ver abajo). Devuelve `{ properties: { hashed_token, action_link, ... }, user }`, **no** un access/refresh token listo para usar.
2. Para canjear eso por una sesión real: `supabase.auth.verifyOtp({ token_hash: hashed_token, type: 'magiclink' })` (`GoTrueClient.d.ts:1236`, tipo `VerifyTokenHashParams` en `lib/types.d.ts:686-691`) — este llamado va contra un cliente **normal** (`createServerClient`, mismo tipo que `middleware.ts:7`), no el admin, para que las cookies de sesión se escriban en la response vía su callback `setAll`.
3. `verifyOtp` devuelve `AuthResponse` = `{ data: { user, session }, error }` (`lib/types.d.ts:180-183`) — `session` trae los tokens reales.
4. **Riesgo a verificar en Fase 3**: el propio docblock de `generateLink` dice que "handles the creation of the user for signup, invite and magiclink" — hay que confirmar que NO crea un usuario duplicado si el email del owner destino ya existe (debería resolverlo al usuario existente, pero no hay precedente en este repo que lo confirme — cero usos de `supabase.auth.admin` en `src/` hoy).

**Patrón de cliente service-role a copiar** (`src/lib/ai/admin-client.ts`, completo):
```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
```
Mismo patrón en `src/lib/flows/admin-client.ts` y `src/lib/automations/admin-client.ts` — crear el equivalente `src/lib/platform-admin/admin-client.ts`.

**Convenciones de migración a seguir** (de 037/038, ya aplicadas en este repo):
- Comentario de cabecera explicando qué hace la migración y qué NO hace.
- `DROP POLICY IF EXISTS` + `CREATE POLICY` para políticas re-ejecutables (patrón de `037:87-90`).
- Guard `DO $$ IF NOT EXISTS (SELECT 1 FROM pg_constraint ...) $$` para `ADD CONSTRAINT` (Postgres no tiene `IF NOT EXISTS` nativo ahí).
- Funciones `SECURITY DEFINER` con `SET search_path = public` (patrón de `can_access_line()` en `037`).

**UI reutilizable (ya usado repetidamente en este repo, sin necesidad de re-descubrir):**
- Patrón lista: `Card` + `<CardContent className="p-0">` + `<ul className="divide-y divide-border">` + fila con acción a la derecha — usado en `members-tab.tsx`, `whatsapp-lines-panel.tsx`.
- Patrón banner: `aiBanner` en Inbox (`messages/en.json` namespace `Inbox.aiBanner`) — mismo lenguaje visual para el banner de impersonación.
- `SettingsPanelHead` (`src/components/settings/settings-panel-head.tsx`) para títulos de sección con acción a la derecha.

---

## Fase 1 — Esquema

**Qué implementar** (nueva migración `039_platform_admin.sql`):
1. `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;` — no se toca `profiles.account_id`.
2. Tipo `account_status_enum` (`DO $$ ... CREATE TYPE ... $$`, patrón de `017:50-55`): `'active' | 'suspended' | 'pending_deletion'`.
3. `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS status account_status_enum NOT NULL DEFAULT 'active', ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;`
4. `CREATE TABLE impersonation_sessions (id UUID PK, platform_admin_id UUID REFERENCES profiles(id), target_account_id UUID REFERENCES accounts(id), target_profile_id UUID REFERENCES profiles(id), reason TEXT, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ);` + índice en `target_account_id` (para el historial visible en el detalle de cuenta) y en `platform_admin_id`.
5. RLS en `impersonation_sessions`: SELECT para `is_account_member(target_account_id)` (así el cliente ve su propio historial, según decisión de transparencia del spec) O `platform_admin_id` resuelve al `auth.uid()` actual (para que el equipo interno vea su propio historial); INSERT/UPDATE solo vía service role (sin policy de cliente — las rutas `/api/platform-admin/*` bypasean RLS de todos modos).
6. Nueva función `SECURITY DEFINER` `can_access_line()` **no se toca** — pero `is_account_member()` (`017:136-166`) se extiende para exigir `EXISTS (SELECT 1 FROM accounts a WHERE a.id = target_account_id AND a.status = 'active')` además de la membresía. Esto bloquea automáticamente TODAS las tablas que ya llaman `is_account_member()` (~15 tablas) sin tocar ninguna política individual — mismo razonamiento que `can_access_line()` en `037`, pero aquí sí se modifica la función compartida porque "cuenta suspendida = bloqueada en todos lados" es exactamente la semántica que se quiere propagar a todo lo existente.
7. Otorgar `is_platform_admin = true` manualmente vía SQL a la(s) cuenta(s) del equipo interno — no hay UI para esto en v1 (documentar el `UPDATE profiles SET is_platform_admin = true WHERE user_id = '<uuid>'` en el mensaje de commit o en un comentario de la migración, no ejecutarlo automáticamente).

**Verificación:**
- Migración corre limpia en un entorno de prueba.
- Una cuenta con `status = 'suspended'` no puede leer/escribir en `contacts` (o cualquier tabla que use `is_account_member`) vía las policies normales — confirma que la extensión de la función se propagó.
- `impersonation_sessions` vacía y accesible solo por su RLS.

**Guardas anti-patrón:**
- No modificar `can_access_line()` — sigue llamando a `is_account_member()` internamente, y su extensión de `status='active'` se hereda gratis.
- No dar acceso de cliente (INSERT/UPDATE) a `impersonation_sessions` — todo pasa por rutas service-role.

---

## Fase 2 — Rutas `/api/platform-admin/*` (lectura + acciones básicas)

**Qué implementar:**
1. Helper `requirePlatformAdmin()` en `src/lib/platform-admin/auth.ts` — mismo patrón que `requireRole()` en `src/lib/auth/account.ts:182-190`, pero verifica `profiles.is_platform_admin = true` para el `auth.uid()` actual (vía cliente SSR normal, no admin) y lanza `ForbiddenError` si no. Todas las rutas de este grupo empiezan con `const admin = await requirePlatformAdmin()`.
2. `GET /api/platform-admin/accounts` — lista de cuentas con métricas agregadas: nombre, owner (email), `status`, cantidad de miembros, cantidad de líneas (`whatsapp_lines` count), fecha de creación. Usa `supabaseAdmin()` (Fase 0) para cruzar cuentas sin las restricciones de RLS normales.
3. `GET /api/platform-admin/accounts/[id]` — detalle: cuenta completa, líneas (`whatsapp_lines` de esa cuenta), métricas (conteo de `conversations`, `messages` últimos 30 días, `profiles` count), últimas filas de `impersonation_sessions` para esa cuenta.
4. `POST /api/platform-admin/accounts/[id]/suspend` y `.../reactivate` — `UPDATE accounts SET status = ...`.
5. `POST /api/platform-admin/accounts/[id]/request-deletion` — `UPDATE accounts SET status = 'pending_deletion', deletion_requested_at = NOW()`. `POST .../cancel-deletion` — revierte a `status = 'active', deletion_requested_at = NULL` (reactivar dentro del período de gracia).

**Verificación:**
- Un usuario sin `is_platform_admin` recibe 403 en cualquier ruta de este grupo, incluidos owners/admins de cuentas cliente normales.
- Suspender una cuenta de prueba bloquea inmediatamente sus queries normales (cross-check con Fase 1).

**Guardas anti-patrón:**
- Ninguna ruta de este grupo usa el cliente RLS-scoped del usuario para leer datos de OTRAS cuentas — siempre `supabaseAdmin()`, con `requirePlatformAdmin()` como el único gate de autorización.

---

## Fase 3 — Impersonación

**Qué implementar:**
1. `POST /api/platform-admin/accounts/[id]/impersonate` — body opcional `{ reason?: string }`.
   - Resuelve el `profile` con `account_role = 'owner'` de la cuenta destino (una sola fila, constraint `idx_accounts_one_per_owner` ya garantiza unicidad de owner).
   - Bloquea si `accounts.status !== 'active'` (409 — "reactiva la cuenta antes de impersonar", según manejo de errores del spec).
   - `supabaseAdmin().auth.admin.generateLink({ type: 'magiclink', email: ownerEmail })` → toma `hashed_token`.
   - Cliente SSR normal (patrón `middleware.ts:7-24`, pero en un Route Handler usando `cookies()` de `next/headers`): `verifyOtp({ token_hash, type: 'magiclink' })` → session real.
   - Antes de sobreescribir cookies: guarda la identidad original del admin (su `user.id` actual) en una cookie httpOnly aparte (`platform_admin_original_session` o similar) para poder restaurarla al salir.
   - Inserta fila en `impersonation_sessions` (`platform_admin_id`, `target_account_id`, `target_profile_id`, `reason`, `expires_at = NOW() + interval '30 minutes'`).
   - Responde con la URL de redirección al dashboard normal (otro host).
2. `POST /api/platform-admin/impersonation/end` — lee la cookie de identidad original, restaura esa sesión (nuevo `verifyOtp`/refresh, o simplemente recupera las cookies guardadas si se optó por guardarlas directamente en vez de regenerarlas — decisión de implementación, preferir guardar las cookies de sesión originales completas en la cookie aparte en vez de regenerar, es más simple y no requiere una segunda llamada a `generateLink`), completa `ended_at = NOW()` en `impersonation_sessions`.
3. Chequeo de expiración: en el dashboard normal, un middleware/hook liviano verifica si hay una sesión de impersonación activa cuya `expires_at` ya pasó y fuerza el fin de sesión (ver Fase 6 para dónde vive esto en la UI).
4. Reutilizar el feed de actividad existente (`loadActivity()`, visto en `src/app/(dashboard)/dashboard/page.tsx` durante el trabajo de i18n de esta sesión) agregando `impersonation_sessions` como una fuente más — un evento "Soporte de wacrm accedió a esta cuenta" por cada fila con `ended_at IS NOT NULL` o `started_at` reciente.

**Verificación:**
- Impersonar una cuenta `suspended` → bloqueado con el mensaje esperado.
- Sesión de impersonación expira exactamente a los 30 minutos (probar con `expires_at` seteado en el pasado manualmente).
- Salir manualmente restaura la sesión original del admin sin tener que volver a loguearse.
- El evento aparece en la actividad de la cuenta cliente.

**Guardas anti-patrón:**
- No usar el cliente admin (`supabaseAdmin()`) para el paso `verifyOtp` — ese debe ir contra un cliente normal para que las cookies de sesión se escriban correctamente en la response.
- No asumir que `generateLink` nunca crea un usuario nuevo — verificar explícitamente (test manual: llamar con el email de un owner ya existente y confirmar que `data.user.id` coincide con el id ya conocido del owner, no uno nuevo) antes de dar esta fase por cerrada.

---

## Fase 4 — Routing por host

**Qué implementar:**
1. En `src/middleware.ts`, insertar entre la línea 5 y la línea 7 (antes de construir el cliente Supabase anon):
   ```ts
   const host = request.headers.get('host') ?? ''
   const adminHost = process.env.PLATFORM_ADMIN_HOST // ej. "admin.tudominio.com"
   if (adminHost && host === adminHost) {
     const url = request.nextUrl.clone()
     if (!url.pathname.startsWith('/platform-admin')) {
       url.pathname = `/platform-admin${url.pathname === '/' ? '' : url.pathname}`
     }
     return NextResponse.rewrite(url)
   }
   ```
   (La verificación real de `is_platform_admin` sigue viviendo en cada ruta/página bajo `/platform-admin/*` — patrón `requirePlatformAdmin()` de Fase 2 — no en el middleware, para no duplicar la lógica de auth ya centralizada en `requireRole`/`getCurrentAccount`.)
2. Nueva variable de entorno `PLATFORM_ADMIN_HOST` — documentar en `.env.local.example`.
3. Estructura de carpetas `src/app/platform-admin/` — `layout.tsx` propio (no reutiliza `(dashboard)/layout.tsx`), `page.tsx` (redirige a `/accounts`), `login/page.tsx`, `accounts/page.tsx`, `accounts/[id]/page.tsx`.

**Verificación:**
- Request a `admin.<dominio>/accounts` sirve `src/app/platform-admin/accounts/page.tsx`.
- La misma ruta `/platform-admin/accounts` en el dominio principal responde 404 (comportamiento nativo de Next — no hay rewrite hacia allá desde el host normal).
- Tráfico normal en el dominio principal no cambia de comportamiento (todas las pruebas de las Fases 1-9 del plan de multi-número siguen pasando).

**Guardas anti-patrón:**
- No poner el chequeo `is_platform_admin` dentro del middleware mismo — mantenerlo en las rutas/páginas, consistente con cómo ya funciona el resto de la app (`requireRole` se llama dentro de cada ruta, no en middleware).

---

## Fase 5 — UI: lista y detalle de cuentas

**Qué implementar:**
1. `src/app/platform-admin/login/page.tsx` — reutiliza el componente `LoginPage` existente (`src/app/(auth)/login/page.tsx`) tal cual para el formulario; tras autenticar, si `is_platform_admin` es falso, muestra "Acceso denegado" en vez de redirigir al dashboard normal (son hosts distintos).
2. `src/app/platform-admin/accounts/page.tsx` — tabla/lista (patrón `members-tab.tsx` roster) con buscador, columnas: nombre, owner, `status` (badge), líneas, miembros, creada, botón "Ver".
3. `src/app/platform-admin/accounts/[id]/page.tsx` — cabecera (nombre + badge de estado + botones Actuar como/Suspender/Reactivar), tarjetas de métricas (`Card` × 4, mismo componente que el dashboard normal), lista de líneas de WhatsApp de esa cuenta, historial de impersonación, acción de eliminar al final.

**Verificación:**
- Manual: cargar la lista con 2-3 cuentas de prueba, verificar que los conteos coinciden con la realidad de la base.
- Buscador filtra client-side sobre la lista ya cargada (sin ida y vuelta al servidor, mismo patrón que otros buscadores del repo).

**Guardas anti-patrón:**
- No crear componentes de UI nuevos desde cero cuando `Card`/`Button`/el patrón de lista con `divide-y` ya cubren la necesidad — mismo lineamiento que se siguió en las Fases 5-6 del plan de multi-número.

---

## Fase 6 — UI: banner de impersonación en el dashboard normal

**Qué implementar:**
1. Ruta ligera `GET /api/impersonation/status` (dominio normal, no `/platform-admin/*`) — devuelve si la sesión actual corresponde a una impersonación activa (`impersonation_sessions` con `ended_at IS NULL` y `platform_admin_id`/`target_profile_id` coincidentes con el `auth.uid()` actual) y su `expires_at`.
2. En `src/app/(dashboard)/dashboard-shell.tsx` (ya tocado en la sesión de i18n de este mismo trabajo): agregar un banner persistente arriba del `<main>`, mismo lenguaje visual que `aiBanner` de Inbox — "Estás actuando como {cuenta} — quedan {mm}:{ss} · Salir". El botón "Salir" llama a `POST /api/platform-admin/impersonation/end` (cross-host — usar la URL absoluta del host admin) y redirige de vuelta.
3. Cuenta regresiva en el cliente basada en `expires_at`; al llegar a 0, fuerza `handleImpersonationEnd()` automáticamente (mismo endpoint que "Salir").

**Verificación:**
- Banner visible solo durante una sesión de impersonación activa, invisible en uso normal.
- Countdown preciso, expira solo a los 30 minutos.
- "Salir" restaura al admin en `admin.<dominio>` sin tener que volver a loguearse.

**Guardas anti-patrón:**
- No consultar `impersonation_sessions` en cada render — un solo fetch al montar `dashboard-shell.tsx` + countdown puramente client-side, re-verificar solo al expirar o al hacer focus en la pestaña (mismo patrón de `resyncToken` visto en `conversation-list.tsx` durante el trabajo de multi-número).

---

## Fase 7 — Job de purga

**Qué implementar:**
1. Ruta protegida `POST /api/platform-admin/cron/purge-pending-deletions` (protegida por un secreto compartido en el header, patrón ya usado por `src/app/api/automations/cron/route.ts` y `src/app/api/flows/cron/route.ts` — copiar ese mecanismo de auth de cron, no inventar uno nuevo).
2. Borra (`DELETE FROM accounts WHERE status = 'pending_deletion' AND deletion_requested_at < NOW() - INTERVAL '30 days'`) — el `ON DELETE CASCADE` existente en el esquema se encarga del resto.
3. Documentar en el README o en un comentario de la ruta cómo programarlo (cron externo golpeando la URL, o `pg_cron` si el hosting de Supabase lo soporta — mismo lenguaje de incertidumbre que ya tiene el spec).

**Verificación:**
- Cuenta `pending_deletion` con `deletion_requested_at` de hace 31 días → se borra.
- Cuenta `pending_deletion` de hace 10 días → sobrevive.
- Cuenta `active`/`suspended` → nunca se toca, sin importar fechas.

**Guardas anti-patrón:**
- Copiar el mecanismo de autenticación de cron existente (`automations/cron`, `flows/cron`) en vez de inventar uno — mantiene consistencia con cómo ya se protegen los otros crons del repo.

---

## Fase 8 — Cierre y verificación

**Qué implementar:**
1. Actualizar `.env.local.example` con `PLATFORM_ADMIN_HOST`.
2. Barrido: `npx tsc --noEmit`, `eslint` sobre todos los archivos nuevos/tocados, suite de tests completa.
3. Prueba manual de extremo a extremo: crear un usuario con `is_platform_admin = true` a mano, entrar por `admin.<dominio>`, suspender una cuenta de prueba y confirmar que sus usuarios pierden acceso inmediatamente, impersonar esa misma cuenta reactivada, hacer un cambio visible (ej. renombrar la cuenta), salir, confirmar el evento en la actividad del cliente y que la sesión del admin volvió a la suya.
4. Actualizar el README con una sección breve sobre el panel de plataforma (qué es, cómo se otorga `is_platform_admin`, que es opcional para quien auto-hostea wacrm sin operar un SaaS).

**Verificación:**
- Todo lo de arriba en verde.
- `next build` compila (mismo criterio usado en el cierre del plan de multi-número: ignorar errores preexistentes de `mcp-server/`, ajenos a este trabajo).

**Guardas anti-patrón:**
- No dar por buena la Fase 3 (impersonación) solo con tests automatizados — el flujo de auth cross-cliente (`generateLink` + `verifyOtp` + cookies) es exactamente el tipo de cosa que "compila pero no funciona" si algo del manejo de cookies está mal; la prueba manual de extremo a extremo del punto 3 es obligatoria antes de mergear.
