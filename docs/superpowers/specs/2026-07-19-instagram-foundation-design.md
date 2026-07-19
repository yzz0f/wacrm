# Diseño: Instagram — Fundación (sub-proyecto 1 de 4)

**Alcance:** Primer sub-proyecto de un esfuerzo mayor de soporte de Instagram, decompuesto explícitamente en 4 partes independientes porque "paridad completa" junta subsistemas separables y porque Instagram no tiene equivalente 1:1 a los templates aprobados de WhatsApp:

1. **Fundación** (este spec) — esquema, `instagram_accounts`, webhook, envío básico, inbox compartido (texto + medios).
2. Broadcasts — Instagram no tiene templates aprobados; "broadcast" ahí significa mensaje libre dentro de la ventana de 24h, semántica distinta a WhatsApp. Diseño propio, pendiente.
3. Automations + Flows para Instagram. Pendiente.
4. IA auto-reply para Instagram. Pendiente.

Cada sub-proyecto sigue su propio ciclo spec → plan → implementación. Este documento cubre solo el 1.

## Problema

wacrm es 100% WhatsApp hoy — todo el modelo de datos (`contacts.phone NOT NULL`, envío acoplado directo a la Graph API de WhatsApp sin capa de abstracción) asume ese único canal. Instagram Direct Messages es el primer canal adicional.

## Decisiones (de la sesión de brainstorming)

- **Identidad de contacto**: un contacto sigue siendo una fila por canal — si la misma persona escribe por WhatsApp y por Instagram, son dos contactos distintos. Elegido por simplicidad sobre una tabla de identidades unificadas (`contact_identities`), que sería un cambio de esquema mucho mayor.
- **Conexión de cuenta de Instagram**: entrada manual (igual que WhatsApp hoy — el usuario pega `instagram_business_account_id` + `page_id` + `access_token`), no OAuth. Reduce alcance de esta fase; OAuth queda como mejora futura si hace falta.
- **Tipos de mensaje**: texto + medios (imagen/video/audio) desde el arranque, no solo texto.
- **Límite de plan**: una cuenta de Instagram cuenta contra el mismo `max_lines` del plan que las líneas de WhatsApp (un solo límite combinado, no una dimensión nueva).
- **Sin abstracción de canal compartida**: se confirmó en el código que el envío de WhatsApp (`meta-api.ts`) no vive detrás de ninguna interfaz genérica — Instagram entra como integración paralela (archivo nuevo), no como una segunda implementación de un contrato existente.

## Modelo de datos

Migración nueva (número a confirmar contra el estado real de `supabase/migrations/` al momento de implementar).

**`contacts`** — se relaja `phone` a nullable y se agregan dos columnas:

```sql
ALTER TABLE contacts
  ALTER COLUMN phone DROP NOT NULL,
  ADD COLUMN platform TEXT NOT NULL DEFAULT 'whatsapp' CHECK (platform IN ('whatsapp', 'instagram')),
  ADD COLUMN external_id TEXT;  -- IGSID de Instagram; NULL para contactos de WhatsApp

CREATE UNIQUE INDEX idx_contacts_account_platform_external_id
  ON contacts (account_id, platform, external_id) WHERE external_id IS NOT NULL;
```

La deduplicación por teléfono existente (`idx_contacts_account_phone_normalized`, migración 022) no se toca — sigue aplicando solo a contactos con `phone`.

**`instagram_accounts`** (mismo molde que `whatsapp_lines`, migración 037):

```sql
CREATE TABLE instagram_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Instagram',
  instagram_business_account_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  connected_at TIMESTAMPTZ,
  registered_at TIMESTAMPTZ,
  subscribed_apps_at TIMESTAMPTZ,
  last_registration_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

RLS: mismo patrón que `whatsapp_lines` — SELECT vía `is_account_member`, mutación admin+.

**`conversations`** — `line_id` es `NOT NULL` desde la migración 038 (finalización de multi-número). Para soportar un segundo tipo de canal se relaja de nuevo y se agrega su par:

```sql
ALTER TABLE conversations ALTER COLUMN line_id DROP NOT NULL;
ALTER TABLE conversations ADD COLUMN instagram_account_id UUID REFERENCES instagram_accounts(id);
ALTER TABLE conversations ADD CONSTRAINT one_channel_account CHECK (
  (line_id IS NOT NULL AND instagram_account_id IS NULL) OR
  (line_id IS NULL AND instagram_account_id IS NOT NULL)
);
```

Patrón estándar de "pertenece a exactamente uno de N padres" vía FKs nullable + CHECK. El índice único de deduplicación (`UNIQUE(account_id, contact_id, line_id)`, migración 037) se amplía a `UNIQUE(account_id, contact_id, line_id, instagram_account_id)` — sigue funcionando porque exactamente una de las dos columnas es no-nula por fila.

**`messages`** — sin cambios de esquema. Ya es agnóstico de canal (`sender_type`, `content_type` genéricos); `template_name` y el resto de columnas específicas de WhatsApp simplemente no se usan en filas de Instagram.

**`plans.max_lines` / `checkPlanLimit`** — la dimensión `'lines'` en `src/lib/billing/limits.ts` pasa a contar `whatsapp_lines` + `instagram_accounts` combinados contra el mismo límite del plan.

## Webhook + envío

**`POST /api/instagram/webhook`** (+ `GET` de verificación, mismo challenge-response que el webhook de WhatsApp). Payload distinto: Instagram Messaging usa el formato `entry[].messaging[]` heredado de Messenger Platform — `sender.id` es el IGSID del contacto, `recipient.id` es el id de la cuenta de Instagram del negocio. Verificación de firma: mismo mecanismo HMAC que WhatsApp (`META_APP_SECRET` compartido, header `X-Hub-Signature-256`).

Contacto: `findOrCreateInstagramContact(accountId, ownerUserId, igsid, name)` — mismo patrón que `findOrCreateContact` (usado por el webhook de WhatsApp) pero busca/inserta por `(platform='instagram', external_id=igsid)` en vez de `phone`.

Resolución de cuenta destino: el webhook de WhatsApp hoy resuelve la línea por `phone_number_id` del payload contra `whatsapp_lines`. El de Instagram hace el equivalente: matchea `recipient.id` (el id de la cuenta de Instagram del negocio en el payload) contra `instagram_accounts.instagram_business_account_id` para saber a qué cuenta — y por lo tanto a qué `account_id` de wacrm — pertenece el mensaje entrante.

**`src/lib/instagram/meta-instagram-api.ts`** (paralelo a `src/lib/whatsapp/meta-api.ts`, no lo modifica): `sendInstagramText`, `sendInstagramMedia` contra la Graph API de Instagram Messaging. **El shape exacto del request/response se confirma contra la documentación oficial de Meta en el momento de implementar** — mismo criterio que se usó con la integración de MercadoPago en el sub-proyecto de facturación: no asumir el contrato de una API externa de memoria.

**Dispatch de envío**: el route de envío del dashboard resuelve `conversation_id → conversation` y bifurca en un solo punto — si `line_id` está seteado va por `send-message.ts` (WhatsApp), si es `instagram_account_id` va por el nuevo `send-instagram-message.ts`. No se dispersa el chequeo por múltiples call sites.

## UI

- **Settings → Instagram** (panel nuevo, calco de `WhatsAppLinesPanel`/`WhatsAppConfig`): formulario manual para `instagram_business_account_id`, `page_id`, `access_token`.
- **Lista de conversaciones**: cada fila gana un ícono de canal (WhatsApp / Instagram). El filtro de línea existente (visible cuando hay 2+ líneas) se generaliza para listar líneas de WhatsApp + cuentas de Instagram juntas en un mismo dropdown de "canal".
- **Ficha de contacto**: para un contacto de Instagram (`phone IS NULL`), se muestra `external_id`/nombre en el lugar donde hoy se muestra el teléfono — mismo componente, campo condicional según `platform`.

## Fuera de alcance (este sub-proyecto)

- Templates, broadcasts, automations, Flows e IA auto-reply para Instagram — sub-proyectos 2, 3 y 4, cada uno con su propio spec.
- Conexión vía OAuth — entrada manual únicamente por ahora.
- Unificación de un mismo cliente que escribe por ambos canales — cada plataforma genera un contacto separado.
- Reacciones, respuestas a historias (story replies), y otros tipos de mensaje de Instagram más allá de texto/imagen/video/audio.
