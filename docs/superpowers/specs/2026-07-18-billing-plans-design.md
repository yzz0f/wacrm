# Diseño: Facturación y planes

**Alcance:** Sub-proyecto independiente del esfuerzo multi-tenant. Se apoya en `accounts.status` y el panel de super-admin (`docs/superpowers/specs/2026-07-18-platform-admin-panel-design.md`), ya implementados, pero no requiere modificarlos — solo los reutiliza.

Como el resto del template, esto es **opcional**: un fork que se autohospeda para un solo equipo no necesita activarlo. Igual que `PLATFORM_ADMIN_HOST`, queda aislado detrás de su propio módulo y no cambia el comportamiento por defecto.

## Problema

Hoy el panel de super-admin puede suspender/reactivar cuentas, pero todo es manual — no hay ningún mecanismo que cobre de verdad ni que limite qué puede hacer una cuenta según lo que paga. Este sub-proyecto agrega cobro recurrente real (no solo un "plan" decorativo) y automatiza la suspensión por impago.

## Decisiones (de la sesión de brainstorming)

- **Cobro real con tarjeta**, no solo un sistema de límites sin cobrar.
- **Proveedor: MercadoPago**, elegido después de investigar — Stripe no soporta Chile como país vendedor hoy (solo Brasil/México en LatAm), Paddle/Lemon Squeezy tienen elegibilidad de Chile sin confirmar públicamente. MercadoPago funciona hoy sin trámites nuevos y tiene una API de suscripciones real (`/preapproval`).
- **El código queda agnóstico al proveedor** — MercadoPago vive detrás de una interfaz (`BillingProvider`), para poder migrar a Stripe u otro el día que Chile quede soportado, sin tocar el resto del sistema.
- **Modelo: planes con tiers fijos**, no por uso — más simple de implementar y de explicarle al usuario que un esquema `metered`.
- **Dimensiones que diferencian los planes**: líneas de WhatsApp, miembros del equipo (todos los roles — owner/admin/agent/viewer cuentan igual, no solo `account_role = 'agent'`), y acceso al asistente de IA. Volumen de mensajes queda fuera (evita la complejidad de contadores mensuales).
- **Sin plan gratis** — todo pago desde el día 1, con **trial de 14 días** sin tarjeta.
- **2 tiers pagos: Pro y Business**. Valores semilla de referencia para la migración inicial (ajustables sin deploy vía la tabla `plans`, no son un compromiso final de precio):
  - Pro: 3 líneas de WhatsApp, 10 miembros, IA incluida.
  - Business: líneas y miembros ilimitados (`NULL`), IA incluida.
  - Precio exacto en CLP: pendiente de decisión de negocio, se completa al escribir la migración semilla.
- **Autoservicio**: el dueño de cuenta elige y paga su plan solo, vía checkout hospedado por MercadoPago (sin formulario de tarjeta propio — evita alcance de PCI).
- **Al fallar el pago o vencer el trial sin tarjeta**: la cuenta se suspende automáticamente, reusando `accounts.status = 'suspended'` (mismo bloqueo de RLS que ya existe vía `is_account_member()`).

## Arquitectura

Módulo nuevo `src/lib/billing/`, mismo espíritu que el patrón BYO-key de IA (`src/lib/ai/providers/`): una interfaz común, un adapter por proveedor, nada del proveedor concreto se filtra fuera de su archivo.

```ts
// src/lib/billing/providers/types.ts
interface BillingProvider {
  createCheckout(accountId: string, planId: string): Promise<{ checkoutUrl: string }>
  handleWebhookEvent(payload: unknown, headers: Headers): Promise<BillingEvent | null>
}

type BillingEvent =
  | { type: 'payment_confirmed'; externalSubscriptionId: string; periodEnd: string }
  | { type: 'payment_failed'; externalSubscriptionId: string }
  | { type: 'subscription_canceled'; externalSubscriptionId: string }
```

`src/lib/billing/providers/mercadopago.ts` implementa `BillingProvider` contra la API `/preapproval` de MercadoPago. Todo lo que lee el resto del sistema pasa por `BillingEvent`, nunca por el shape crudo de MercadoPago — cambiar de proveedor es escribir un adapter nuevo, no tocar el resto.

## Modelo de datos

Migración nueva (número a asignar en la fase de plan, después de que las migraciones 037-040 ya en curso se resuelvan — ver Fase 0 del plan de implementación).

**`plans`** (seed manual vía migración, sin UI de creación en v1 — mismo patrón que `is_platform_admin`):
```sql
CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key TEXT NOT NULL UNIQUE,              -- 'pro' | 'business'
  name TEXT NOT NULL,
  price_clp_monthly INTEGER NOT NULL,
  max_lines INTEGER,                     -- NULL = ilimitado
  max_agents INTEGER,                    -- NULL = ilimitado
  ai_enabled BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**`account_subscriptions`** (1:1 con `accounts`):
```sql
CREATE TABLE account_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id),
  provider TEXT NOT NULL DEFAULT 'mercadopago',
  external_subscription_id TEXT,
  trial_ends_at TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**`accounts.billing_status`** (columna nueva, tipo `billing_status_enum`: `trialing | active | past_due | canceled`) — separada a propósito de `accounts.status` (`active | suspended | pending_deletion`, del panel de super-admin). Son dos máquinas de estado distintas:
- `accounts.status` es la señal de "¿puede esta cuenta usar el producto?" (lo que ya bloquea `is_account_member()`).
- `accounts.billing_status` es la señal de "¿por qué?" — permite distinguir en el panel de super-admin una suspensión manual de una por impago, sin ambigüedad.

Un cron diario (mismo patrón que la purga de cuentas de Fase 7 del panel de admin) sincroniza ambas: revisa `trial_ends_at`/`current_period_end` vencidos → `billing_status = 'past_due'` → si sigue sin resolverse tras un margen corto de gracia (2-3 días, a definir en el plan), `accounts.status = 'suspended'`. El webhook de MercadoPago revierte ambas automáticamente al confirmar un cobro.

## Enforcement de límites

Helper `checkPlanLimit(accountId, 'lines' | 'members'): Promise<boolean>` en `src/lib/billing/limits.ts`. Las rutas de creación lo llaman antes de insertar:
- Crear línea de WhatsApp (`POST /api/whatsapp/config` con `create: true`).
- Invitar miembro (`POST /api/account/invitations`).

Solo bloquea creación nueva — un downgrade que deja a una cuenta por encima del nuevo límite (ej. Business con 5 líneas baja a Pro, tope 3) no borra ni desconecta nada existente; las líneas/miembros ya creados quedan intactos (grandfathered) hasta que el dueño de cuenta los reduzca manualmente. `checkPlanLimit` solo impide agregar más mientras siga por encima del límite.

IA se gatea distinto: `loadAiConfig` (`src/lib/ai/config.ts`, ya existe) agrega un chequeo de `plans.ai_enabled` para la cuenta antes de devolver la config activa — si el plan no incluye IA, el asistente se comporta como "no configurado" aunque la cuenta tenga una key guardada.

## Checkout + webhook

- **`POST /api/billing/checkout`** (admin+ de la cuenta, vía `requireRole('admin')` existente): crea/actualiza la suscripción en MercadoPago vía el adapter, devuelve `checkoutUrl` — el navegador redirige ahí. Sin formulario de tarjeta propio.
- **`POST /api/billing/webhook`** (público, verificado por firma/secret de MercadoPago — mismo principio que `META_APP_SECRET` en el webhook de WhatsApp): traduce la notificación a `BillingEvent` vía el adapter, aplica el efecto sobre `account_subscriptions` y `accounts.billing_status`/`status`. MercadoPago puede reenviar la misma notificación más de una vez — el handler debe ser idempotente (aplicar el mismo `BillingEvent` dos veces da el mismo resultado, no dos efectos).
- **`GET /api/billing/cron/check-trials`** (mismo patrón de secreto compartido que `automations/cron` y el cron de purga del panel de admin): red de seguridad si el webhook nunca llegó — barre `trial_ends_at`/`current_period_end` vencidos.

## UI

- **`Settings → Billing`** (tab nueva, patrón `SettingsPanelHead` + `Card`, solo admin+): plan actual, `billing_status`, botón "Cambiar de plan" → checkout.
- **Banner de trial/impago** en `dashboard-shell.tsx`, mismo lenguaje visual que `aiBanner` e `ImpersonationBanner`: cuenta regresiva de trial, o aviso de pago pendiente con fecha de suspensión.
- **Panel de super-admin** (`/platform-admin/accounts/[id]`): la tarjeta de métricas ya existente suma plan + `billing_status`. El botón manual de "Suspender" sigue funcionando igual — dos causas conviven en la misma columna `accounts.status`, distinguibles por `billing_status`.
- **Signup**: `handle_new_user` (017_account_sharing.sql, ya existe) se extiende para crear la fila en `account_subscriptions` con plan default = Pro, `billing_status = 'trialing'`, `trial_ends_at = NOW() + INTERVAL '14 days'`. El dueño de cuenta puede pasar a Business en cualquier momento (durante o después del trial) desde `Settings → Billing`, sin que eso afecte la fecha de fin de trial.

## Fuera de alcance (v1)

- UI de creación/edición de planes — se cargan a mano en la migración.
- Facturas/recibos descargables — MercadoPago los genera del lado de ellos.
- Prorrateo al cambiar de plan a mitad de ciclo — un cambio de plan toma efecto en el siguiente ciclo de cobro.
- Métricas de ingresos (MRR, churn) en el panel de super-admin — se puede agregar después leyendo `account_subscriptions`.
