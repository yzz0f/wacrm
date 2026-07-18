# Plan de implementación: Facturación y planes

**Spec:** `docs/superpowers/specs/2026-07-18-billing-plans-design.md`
**Alcance:** Sub-proyecto independiente. Se apoya en `accounts.status` y el panel de super-admin (ya implementados en `main`), sin modificarlos — solo los reutiliza.

Cada fase está pensada para ejecutarse en una sesión nueva, citando archivo:línea del código real.

---

## Fase 0 — Hechos verificados (referencia, no se ejecuta)

**Estado real de las migraciones (verificado contra `origin/main`, no asumido):**
- `origin/main` hoy (antes de este plan) tiene la migración 037 **duplicada**: `037_platform_admin.sql` y `037_whatsapp_lines.sql` coexisten, seguidas de `038_whatsapp_lines_finalize.sql`. Esto ya está resuelto en dos PRs abiertos pero no mergeados al momento de escribir este plan:
  - PR #4 (`fix/duplicate-migration-037`) renombra `037_platform_admin.sql` → `039_platform_admin.sql`.
  - PR #5 (`feat/ai-gemini-provider`, con base en PR #4) agrega `040_ai_gemini_provider.sql`.
- **Antes de escribir la migración de la Fase 1**, correr `git log origin/main --oneline -5` y `ls supabase/migrations/ | tail -10` para confirmar el número real disponible. Si PR #4 y #5 ya mergearon, el siguiente número libre es **041**. Si no mergearon, hay que decidir: o esperar a que mergeen, o numerar contra lo que exista y aceptar un posible re-render más adelante (mismo tipo de colisión que motivó el PR #4 — mejor evitarla si se puede).

**`handle_new_user` — trigger de signup a extender** (`supabase/migrations/017_account_sharing.sql:659-683`, sin redefiniciones posteriores — verificado por grep en todo `supabase/migrations/*.sql`):
- Cuerpo actual, en orden:
  1. `INSERT INTO public.accounts (name, owner_user_id) VALUES (...) RETURNING id INTO v_account_id;` (`017:671-673`)
  2. `INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role) VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');` (`017:675-676`)
- Todo el cuerpo está envuelto en `EXCEPTION WHEN OTHERS THEN RAISE WARNING ...; RETURN NEW;` (`017:679-681`) — una falla no bloquea el signup, solo lo deja sin bootstrapear (mismo comportamiento a preservar para el nuevo insert de `account_subscriptions`).
- Punto de inserción: un tercer `INSERT INTO public.account_subscriptions (...)` justo después del insert de `profiles`, usando `v_account_id` ya resuelto, dentro del mismo bloque `BEGIN...EXCEPTION`.

**Patrón de adapter a copiar** (`src/lib/ai/providers/`, ya implementado — usar `openai.ts` como referencia, es el más simple):
- Un archivo por proveedor, cada uno exporta una función `generate<Provider>(args): Promise<ProviderResult>` con firma idéntica (`src/lib/ai/providers/openai.ts:27`).
- Un solo punto de dispatch: `src/lib/ai/generate.ts:37-49`, un `switch` sobre el campo discriminante, nada más en el codebase llama a los adapters directamente.
- Helpers compartidos extraídos a un archivo `shared.ts` (`src/lib/ai/providers/shared.ts`) — mapeo de errores de red, normalización de campos con distinto shape entre proveedores.
- **Para billing**: `src/lib/billing/providers/types.ts` define `BillingProvider`/`BillingEvent` (ver spec); `src/lib/billing/providers/mercadopago.ts` es el único adapter inicial; el dispatch vive en un único punto (`src/lib/billing/dispatch.ts` o directo en las rutas, a decidir en Fase 3 según cuántos call-sites terminen necesitándolo — con un solo proveedor no hace falta un switch todavía, alcanza con importar el adapter directo).

**`requireRole` — guard a reusar en las rutas nuevas** (`src/lib/auth/account.ts:182-190`): `requireRole(min: AccountRole): Promise<AccountContext>`, devuelve `{ supabase, userId, accountId, role, account }` (`account.ts:20-22`). Las rutas de billing que solo el dueño/admin puede tocar (`POST /api/billing/checkout`) llaman `await requireRole('admin')` igual que el resto del código de Settings.

**Patrón de cron secret a copiar** (`src/app/api/platform-admin/cron/purge-pending-deletions/route.ts:20-27`, mismo patrón que `automations/cron`/`flows/cron`):
```ts
const expected = process.env.PLATFORM_ADMIN_CRON_SECRET // → BILLING_CRON_SECRET para este caso
if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
const supplied = request.headers.get('x-cron-secret')
if (supplied !== expected) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
```

**Settings tabs — cómo se registra una sección nueva** (verificado, con una corrección importante a la suposición del spec: no existe hoy un tab "AI Assistant" en Settings — `ai-config.tsx` se usa en `/agents`, no en Settings. El patrón real de tabs es):
1. Agregar `'billing'` al array `SETTINGS_SECTIONS` (`src/components/settings/settings-sections.ts:24-36`).
2. Agregar su entrada a `SECTION_META` (`settings-sections.ts:50-62`), grupo `'workspace'`, ícono de `lucide-react` (ej. `CreditCard`).
3. Importar el componente nuevo y agregarlo al objeto `panel` en `src/app/(dashboard)/settings/page.tsx:60-71` (imports arriba, `:9-20`).

**Banner de trial/impago — patrón visual a copiar** (`src/components/layout/impersonation-banner.tsx`, 86 líneas, ya implementado; wired en `src/app/(dashboard)/dashboard-shell.tsx:10,53`): un componente `'use client'` con un solo fetch de estado al montar (no por render), countdown local si aplica, `<button>` con estilo `border-border bg-card` consistente con `aiBanner`. Para billing: mismo lugar en `dashboard-shell.tsx`, junto a (no reemplazando) `<ImpersonationBanner />`.

---

## Fase 1 — Esquema

**Qué implementar** (nueva migración, número confirmado en Fase 0 — asumir `041_billing_plans.sql` salvo que la verificación diga otra cosa):
1. `CREATE TYPE billing_status_enum AS ENUM ('trialing', 'active', 'past_due', 'canceled');` (patrón `DO $$ IF NOT EXISTS ... $$` de `017:50-55`).
2. `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS billing_status billing_status_enum NOT NULL DEFAULT 'trialing';` — separada de `accounts.status` (ya existe desde `039_platform_admin.sql`), no se toca esa columna ni `is_account_member()`.
3. `CREATE TABLE plans (...)` — columnas exactas en el spec (`docs/superpowers/specs/2026-07-18-billing-plans-design.md`, sección "Modelo de datos"). Seed con `INSERT INTO plans (...) VALUES (...)` para Pro y Business usando los valores de referencia del spec (3 líneas/10 miembros/IA para Pro; `NULL`/`NULL`/IA para Business) — precio en CLP a completar con el valor de negocio real antes de aplicar en producción, documentarlo como tal en un comentario de la migración.
4. `CREATE TABLE account_subscriptions (...)` — columnas exactas en el spec, `UNIQUE` en `account_id`, `FK` a `plans(id)` y `accounts(id)`.
5. RLS en `account_subscriptions` y `plans`: SELECT vía `is_account_member(account_id)` para que el dueño de cuenta vea su propia suscripción (`plans` es de lectura pública para cualquier autenticado, ya que solo expone precios/límites); sin policy de INSERT/UPDATE/DELETE de cliente — todo pasa por rutas service-role, mismo criterio que `impersonation_sessions` en `039_platform_admin.sql`.
6. Extender `handle_new_user` (`017_account_sharing.sql:659-683`) con el `CREATE OR REPLACE FUNCTION` de siempre (no se edita el archivo 017, se redefine en la migración nueva): agregar el insert de `account_subscriptions` con `plan_id` resuelto por `SELECT id FROM plans WHERE key = 'pro'`, `billing_status` ya queda default `'trialing'` en `accounts` (no hace falta setearlo acá), `trial_ends_at = NOW() + INTERVAL '14 days'`.

**Verificación:**
- Migración corre limpia en un entorno de prueba (revisión manual de balance de paréntesis/`$$`, mismo criterio que se usó en 037_whatsapp_lines por falta de Postgres local disponible).
- Un signup nuevo crea las 3 filas (`accounts`, `profiles`, `account_subscriptions`) en una sola transacción implícita del trigger.
- `plans` tiene exactamente 2 filas activas (`pro`, `business`).

**Guardas anti-patrón:**
- No tocar `is_account_member()` ni `accounts.status` — `billing_status` es una columna nueva y separada a propósito (ver spec).
- No dar acceso de cliente (INSERT/UPDATE) a `plans`/`account_subscriptions` — todo vía service role.

---

## Fase 2 — `checkPlanLimit` + gate de IA

**Qué implementar:**
1. `src/lib/billing/limits.ts` — `checkPlanLimit(db: SupabaseClient, accountId: string, dimension: 'lines' | 'members'): Promise<{ allowed: boolean; limit: number | null; current: number }>`. Lee `account_subscriptions.plan_id` → `plans.max_lines`/`max_agents`, cuenta filas actuales (`whatsapp_lines` o `profiles` por `account_id`), compara. `limit: null` (ilimitado) siempre `allowed: true`.
2. Llamar `checkPlanLimit` en:
   - Crear línea de WhatsApp — `POST /api/whatsapp/config` con `create: true` (ver `src/app/api/whatsapp/config/route.ts`, ya migrado a `whatsapp_lines` tras el merge de PR #2). Devolver 402 con mensaje "Alcanzaste el límite de líneas de tu plan" si `!allowed`.
   - Invitar miembro — `POST /api/account/invitations` (ubicar la ruta exacta en el código actual antes de editar; verificar que el insert de invitación sea el punto correcto o si el límite debe aplicarse en la aceptación de la invitación, no en el envío — un exceso de invitaciones pendientes no debería bloquear per se, solo la aceptación que de verdad crea el miembro. Confirmar contra `redeem_invitation` RPC).
3. Extender `loadAiConfig` (`src/lib/ai/config.ts:31-83`) — después de cargar la config, un chequeo adicional: `SELECT ai_enabled FROM plans p JOIN account_subscriptions s ON s.plan_id = p.id WHERE s.account_id = $1`. Si `ai_enabled = false`, devolver `null` (mismo comportamiento que "no configurado", documentado ya en el comentario de la función).

**Verificación:**
- Cuenta en plan Pro con 3 líneas ya creadas → un 4to intento de crear línea devuelve 402.
- Cuenta en plan Business (límites `NULL`) → nunca bloquea.
- Cuenta cuyo plan tiene `ai_enabled = false` → `loadAiConfig` devuelve `null` aunque `is_active = true` en `ai_configs`.
- Downgrade de Business a Pro con 5 líneas ya creadas → esas 5 líneas siguen funcionando (grandfathering, ver spec), pero crear una 6ta falla.

**Guardas anti-patrón:**
- No borrar ni desactivar recursos existentes al detectar que una cuenta está por encima del límite — `checkPlanLimit` es puramente preventivo hacia adelante.

---

## Fase 3 — Checkout + webhook (MercadoPago)

**Qué implementar:**
1. `src/lib/billing/providers/types.ts` — `BillingProvider` interface y `BillingEvent` union type, tal como están en el spec.
2. `src/lib/billing/providers/mercadopago.ts` — implementa `createCheckout(accountId, planId)` llamando a la API `/preapproval` de MercadoPago (revisar la documentación oficial de MercadoPago para el shape exacto del request/response antes de codear — no asumir el shape, es la única llamada externa nueva de esta fase y el equivalente al "verificar generateLink contra los `.d.ts` instalados" que se hizo en el panel de admin, pero aquí no hay SDK instalado — confirmar contra la documentación pública de MercadoPago en el momento de implementar). `handleWebhookEvent(payload, headers)` valida la firma/secret de la notificación (MercadoPago usa un secret de webhook configurable en su panel — documentar la variable de entorno `MERCADOPAGO_WEBHOOK_SECRET`) y traduce el payload a `BillingEvent`.
3. `POST /api/billing/checkout` — `requireRole('admin')`, body `{ plan_key: 'pro' | 'business' }`, resuelve `plan_id`, llama al adapter, devuelve `{ checkoutUrl }`.
4. `POST /api/billing/webhook` — sin `requireRole` (no hay sesión de usuario en un webhook externo), valida firma primero que cualquier otra cosa (mismo orden que el webhook de WhatsApp: verificar antes de parsear). Traduce a `BillingEvent`, aplica:
   - `payment_confirmed` → `UPDATE account_subscriptions SET current_period_end = ...`, `UPDATE accounts SET billing_status = 'active', status = 'active' WHERE ...` (revierte una suspensión previa por impago; no toca una suspensión manual — ver nota de Fase 4 sobre cómo distinguirlas).
   - `payment_failed` → `UPDATE accounts SET billing_status = 'past_due'`.
   - `subscription_canceled` → `UPDATE accounts SET billing_status = 'canceled'`.
   - Idempotente: cada `UPDATE` es un set absoluto por `external_subscription_id`, no un incremento — aplicar el mismo evento dos veces dea el mismo estado final (ver guarda anti-patrón).

**Verificación:**
- Checkout devuelve una URL válida de MercadoPago en un entorno de prueba/sandbox.
- Webhook con firma inválida → 401, no aplica ningún efecto.
- Webhook con firma válida pero `external_subscription_id` desconocido → no rompe, no aplica efecto, loggea.
- Enviar el mismo evento de webhook dos veces seguidas → mismo estado final, sin duplicar filas ni efectos secundarios.

**Guardas anti-patrón:**
- No usar el cliente RLS-scoped del usuario en el webhook — no hay usuario. Usar `supabaseAdmin()` (mismo patrón que `src/lib/platform-admin/admin-client.ts`, copiar el mismo factory para `src/lib/billing/admin-client.ts`).
- No inventar el shape de la API de MercadoPago — confirmarlo contra su documentación pública en el momento de implementar esta fase, no contra lo que este plan supone.

---

## Fase 4 — Cron de sincronización trial/impago

**Qué implementar:**
1. `GET /api/billing/cron/check-trials` — mismo mecanismo de `x-cron-secret` que `src/app/api/platform-admin/cron/purge-pending-deletions/route.ts:20-27`, variable `BILLING_CRON_SECRET`.
2. Lógica: `SELECT` cuentas donde `billing_status = 'trialing' AND trial_ends_at < NOW()` → `UPDATE billing_status = 'past_due'`. `SELECT` cuentas donde `billing_status = 'past_due' AND <fecha de corte de gracia, ej. updated_at + 3 días> < NOW()` → `UPDATE accounts SET status = 'suspended'`.
3. **Distinguir causa de suspensión**: `accounts.status = 'suspended'` ya lo puede setear el super-admin a mano (Fase 2 del panel de admin, `POST /api/platform-admin/accounts/[id]/suspend`). Este cron NO debe reactivar una cuenta suspendida manualmente si el pago se resuelve — el webhook de la Fase 3 solo debe reactivar `status` cuando la causa fue `billing_status = 'past_due'`, nunca cuando fue una suspensión manual sin relación a billing. Verificar esto explícitamente: agregar una columna o usar `billing_status` como fuente de verdad — si `billing_status` está en `'past_due'` al momento del pago confirmado, es seguro reactivar `status`; si `billing_status` ya era `'active'` y `status` es `'suspended'`, la causa fue manual y el webhook NO debe tocar `status`.

**Verificación:**
- Cuenta con trial vencido de ayer → pasa a `past_due` en la próxima corrida del cron.
- Cuenta en `past_due` desde hace 4 días → pasa a `status = 'suspended'`.
- Cuenta suspendida manualmente por el super-admin (billing al día) → el webhook de un pago no la reactiva.
- Cuenta suspendida por impago → el webhook de un pago exitoso sí la reactiva.

**Guardas anti-patrón:**
- No reactivar `accounts.status` en el webhook de pago sin antes confirmar que la causa de la suspensión fue `billing_status`, no una acción manual del panel de admin.

---

## Fase 5 — UI: Settings → Billing

**Qué implementar:**
1. `src/components/settings/billing-panel.tsx` — patrón `SettingsPanelHead` + `Card` (mismo que `whatsapp-lines-panel.tsx`/`members-tab.tsx`): plan actual, `billing_status`, botón "Cambiar de plan" por cada plan disponible que no sea el actual → `POST /api/billing/checkout` → `window.location.href = checkoutUrl`.
2. Registrar la sección: `'billing'` en `SETTINGS_SECTIONS` (`src/components/settings/settings-sections.ts:24-36`), entrada en `SECTION_META` (`:50-62`, ícono `CreditCard` de `lucide-react`, `group: 'workspace'`), import + entrada en `panel` (`src/app/(dashboard)/settings/page.tsx:9-20` y `:60-71`).
3. Solo visible/editable para `admin+` — mismo patrón `canEditSettings(accountRole)` usado en `ai-config.tsx:52-53`.

**Verificación:**
- Un viewer/agent ve el plan actual en modo lectura, sin botón de cambio.
- Un admin+ puede iniciar checkout y termina en una URL de MercadoPago.

**Guardas anti-patrón:**
- No crear un formulario de tarjeta propio — el checkout siempre redirige a MercadoPago (fuera de alcance de PCI, ya decidido en el spec).

---

## Fase 6 — UI: banner de trial/impago + panel de super-admin

**Qué implementar:**
1. `src/components/layout/billing-banner.tsx` — mismo patrón que `impersonation-banner.tsx` (fetch de estado al montar, no por render). Estado `trialing` → "Tu prueba termina en X días — Agregar método de pago". Estado `past_due` → "Pago pendiente — tu cuenta se suspenderá el {fecha}". Sin banner en `active`/`canceled` (canceled ya implica cuenta inaccesible vía `status`).
2. Agregar `<BillingBanner />` en `src/app/(dashboard)/dashboard-shell.tsx` junto a `<ImpersonationBanner />` (línea `:53`), ambos pueden convivir (son estados independientes).
3. `GET /api/billing/status` — ruta liviana análoga a `GET /api/impersonation/status` (`src/app/api/impersonation/status/route.ts`), devuelve `{ billing_status, trial_ends_at, current_period_end }` de la cuenta del caller.
4. Panel de super-admin: extender `GET /api/platform-admin/accounts/[id]` (`src/app/api/platform-admin/accounts/[id]/route.ts`) para incluir `billing_status` y el nombre del plan en la respuesta; sumar esos dos datos a las tarjetas de métrica en `src/app/platform-admin/accounts/[id]/account-detail-client.tsx` (mismo componente `MetricCard` ya definido ahí).

**Verificación:**
- Banner de trial visible solo en `trialing`, desaparece al confirmar el pago.
- El detalle de cuenta en `/platform-admin/accounts/[id]` muestra plan + `billing_status` junto a las métricas existentes.

**Guardas anti-patrón:**
- No dupli­car la lógica de fetch-al-montar del `ImpersonationBanner` copiándola mal — reusar el mismo patrón de un solo fetch, no un polling.

---

## Fase 7 — Cierre y verificación

**Qué implementar:**
1. Documentar en `.env.local.example`: `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, `BILLING_CRON_SECRET` — sección nueva, mismo formato que la de "Platform admin panel (optional)".
2. Barrido: `npx tsc --noEmit`, `eslint` sobre todos los archivos nuevos/tocados, suite de tests completa (`checkPlanLimit`, el adapter de MercadoPago con fetch mockeado igual que los tests de `src/lib/ai/generate.test.ts`, idempotencia del webhook).
3. Prueba manual de extremo a extremo en sandbox de MercadoPago: signup nuevo → trial de 14 días visible → checkout a Pro → webhook confirma pago → banner desaparece → forzar `trial_ends_at`/`current_period_end` al pasado manualmente en la DB → correr el cron → cuenta pasa a `past_due` luego a `suspended` → los usuarios de esa cuenta pierden acceso (cross-check con `is_account_member()`).
4. Actualizar el README con una sección "Facturación y planes (opcional)", mismo formato que la sección "Platform admin panel (optional)" ya existente.

**Verificación:**
- Todo lo de arriba en verde.
- `next build` compila (ignorar errores preexistentes de `mcp-server/`, ajenos a este trabajo, mismo criterio que los cierres anteriores).

**Guardas anti-patrón:**
- No dar la Fase 3 (checkout/webhook) por cerrada solo con tests automatizados — el flujo real contra el sandbox de MercadoPago es el único modo de confirmar que el shape de la API asumido en el código es correcto.
