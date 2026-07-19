# Plan de implementación: Instagram — Fundación (sub-proyecto 1 de 4)

**Spec:** `docs/superpowers/specs/2026-07-19-instagram-foundation-design.md`
**Alcance:** Solo la fundación (esquema, `instagram_accounts`, webhook, envío básico, inbox compartido). Templates/broadcasts/automations/Flows/IA quedan para los sub-proyectos 2-4, no se tocan acá.

Cada fase está pensada para ejecutarse en una sesión nueva, citando archivo:línea del código real.

---

## Fase 0 — Hechos verificados (referencia, no se ejecuta)

**Estado de migraciones** (verificado contra `main` real): la última es `042_billing_member_limit.sql`. La migración de este plan es **`043_instagram_foundation.sql`** — confirmar contra `ls supabase/migrations/` al momento de implementar, no asumir.

**`findOrCreateContact`** (`src/app/api/whatsapp/webhook/route.ts:995-1053`) — patrón a espejar, no a reusar (está scoped como función privada del archivo y opera sobre `phone`):
- Lookup delega en `findExistingContact(supabaseAdmin(), accountId, phone)` (`src/lib/contacts/dedupe.ts:35-56`): normaliza el teléfono, prefiltra por sufijo de 8 dígitos vía `LIKE`, luego hace match estricto en JS (`phonesMatch`). **No aplica a Instagram** — un IGSID no es un teléfono, no hay sufijo que prefiltrar.
- Insert on miss (`route.ts:1028-1037`): `{ account_id, user_id, phone, name }`.
- Manejo de carrera (`route.ts:1039-1050`): en unique-violation (`isUniqueViolation`, `dedupe.ts:72-75`, código Postgres `23505`), re-resuelve en vez de fallar — este patrón sí se copia tal cual.

**`processMessage`** (`route.ts:565-838`) — 16 pasos: normalizar remitente → resolver/crear contacto → resolver/crear conversación → emitir `conversation.created` → corto-circuito de reacciones → parsear contenido → resolver reply-to → mapear content_type → contar mensajes previos (`isFirstInboundMessage`) → insertar mensaje → actualizar conversación → `flagBroadcastReplyIfAny` → `dispatchInboundToFlows` → disparar automations → `dispatchInboundToAiReply` → `dispatchWebhookEvent`. **`processInstagramMessage` de esta fase omite los pasos de broadcast-reply-flag, Flows, automations y AI auto-reply** (`route.ts:719, 740-760, 762-808, 815-822`) — todos fuera de alcance de este sub-proyecto según el spec. Sí incluye el `dispatchWebhookEvent` final (`route.ts:831-837`), que es infraestructura ya genérica de canal.

**Verificación de firma HMAC** — **reusable tal cual**: `verifyMetaWebhookSignature(rawBody, signatureHeader)` (`src/lib/whatsapp/webhook-signature.ts:21-47`) no tiene ninguna asunción de ruta ni de WhatsApp — toma `rawBody` + el valor del header como strings planos, usa `META_APP_SECRET` global, compara con `crypto.timingSafeEqual`. El webhook de Instagram la importa y la llama exactamente igual que `route.ts:172-184` (header `x-hub-signature-256`, mismo nombre en ambos productos de Meta).
La verificación GET (challenge/verify-token) **no es reusable** — está hardcodeada a iterar `whatsapp_lines` y su columna `verify_token` (`route.ts:90-169, 105-132`). El de Instagram necesita su propio handler GET contra `instagram_accounts`.

**Resolución de línea/cuenta** (`route.ts:248-286`): matchea `value.metadata.phone_number_id` del payload contra `whatsapp_lines.phone_number_id` (columna UNIQUE), sin `.single()` — chequea longitud 0 (dropear mensaje) y longitud >1 (ambiguo, dropear con log) por separado. El equivalente de Instagram matchea `recipient.id` del payload contra `instagram_accounts.instagram_business_account_id`, mismo patrón de 0/1/N filas.

**`findOrCreateConversation`** (`route.ts:1055-1132`): lookup por `(account_id, contact_id, line_id)` sin `.single()` (toma la fila más vieja, evita el bug de duplicados del issue #363); insert con `line_id` seteado solo en creación, nunca actualizado después (`route.ts:576-580`). Mismo patrón para `instagram_account_id`.

**`checkPlanLimit`** (`src/lib/billing/limits.ts:25-54`): dimensión `'lines'` hoy hace una sola query de conteo contra `whatsapp_lines` (`limits.ts:47-51`: `db.from('whatsapp_lines').select('id', {count:'exact', head:true}).eq('account_id', accountId)`). Se extiende sumando una segunda query de conteo contra `instagram_accounts` cuando `dimension === 'lines'`.

**`WhatsAppLinesPanel`** (`src/components/settings/whatsapp-lines-panel.tsx`) — patrón lista+detalle genérico, copiable casi textual: state `view: 'list' | 'new' | string` (`:42`), fetch `loadLines` (`:44-58`), delete con `confirm()` (`:65-85`), render con `canManage` gating (`:106-206`). Nada específico de WhatsApp salvo nombres de campo.

**`WhatsAppConfig`** (`src/components/settings/whatsapp-config.tsx`) — props `{ lineId?, onSaved?, onDeleted?, onBack? }` (`:40-50`). **Dos secciones NO aplican a Instagram y se omiten en el equivalente**: el bloque "Registration Status" (`:513-614`, dos fases `/register`+`/subscribed_apps` con PIN — Instagram no tiene este paso) y la tarjeta de URL de webhook con auto-registro (`:725-753`). El formulario de credenciales (`:617-723`, campos `lineName`/`phoneNumberId`/`wabaId`/`accessToken` con máscara/mostrar-ocultar/`verifyToken`/`pin`) es el template, cambiando los campos por `name`/`instagramBusinessAccountId`/`pageId`/`accessToken` (sin PIN).

**Filtro de línea en inbox** (`src/components/inbox/conversation-list.tsx`): `lines` de `useAuth()` (`:58`), estado `selectedLineId` (`:77`), filtro aplicado client-side sobre la lista ya cargada (`:189-191`), dropdown gated `lines.length > 1` (`:321-367`), badge condicional por conversación (`:478, 567-571`). Para unificar WhatsApp+Instagram en un solo dropdown de "canal" hace falta generalizar `:189-191` y el `linesById` map — no es solo agregar un segundo dropdown.

**`useAuth()`** (`src/hooks/use-auth.tsx`): `lines: WhatsAppLine[]` se puebla dentro de `fetchProfile` (`:203-223`), misma query shape que `WhatsAppLinesPanel.loadLines`. Agregar `instagramAccounts` es el mismo patrón: nuevo `useState`, misma query contra `instagram_accounts` dentro del mismo bloque `if (data.account_id)` (`:203-224`), sumarlo al spread del provider (`:373-390`) y a las dependencias del `derived` memo (`:371`).

---

## Fase 1 — Esquema

**Qué implementar** (`043_instagram_foundation.sql`):
1. `ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL, ADD COLUMN platform TEXT NOT NULL DEFAULT 'whatsapp' CHECK (platform IN ('whatsapp','instagram')), ADD COLUMN external_id TEXT;`
2. `CREATE UNIQUE INDEX idx_contacts_account_platform_external_id ON contacts (account_id, platform, external_id) WHERE external_id IS NOT NULL;` — no toca `idx_contacts_account_phone_normalized` (022).
3. `CREATE TABLE instagram_accounts (...)` — columnas exactas del spec (id, account_id, user_id, name, instagram_business_account_id, page_id, access_token, status, is_default, connected_at, registered_at, subscribed_apps_at, last_registration_error, created_at, updated_at). RLS: `SELECT` vía `is_account_member(account_id)`, mutación vía rutas admin+ (mismo patrón que `whatsapp_lines`, `037_whatsapp_lines.sql`).
4. `ALTER TABLE conversations ALTER COLUMN line_id DROP NOT NULL; ADD COLUMN instagram_account_id UUID REFERENCES instagram_accounts(id); ADD CONSTRAINT one_channel_account CHECK ((line_id IS NOT NULL AND instagram_account_id IS NULL) OR (line_id IS NULL AND instagram_account_id IS NOT NULL));`
5. Ampliar el índice único de deduplicación de conversaciones (`UNIQUE(account_id, contact_id, line_id)` de `037_whatsapp_lines.sql`) a `UNIQUE(account_id, contact_id, line_id, instagram_account_id)`.

**Verificación:**
- Migración corre limpia (revisión manual de balance de paréntesis/`$$`, mismo criterio de siempre ante falta de Postgres local).
- Insertar un contacto con `phone = NULL, platform = 'instagram', external_id = 'test123'` no rompe ningún constraint existente.
- Insertar una conversación con ambos `line_id` e `instagram_account_id` en `NULL` (o ambos seteados) falla por el CHECK.

**Guardas anti-patrón:**
- No tocar `idx_contacts_account_phone_normalized` ni `is_account_member()`/`can_access_line()`.
- No hacer `phone` NOT NULL de nuevo en ningún punto de esta fase — es la base de todo lo demás.

---

## Fase 2 — Límite de plan combinado

**Qué implementar:**
- Extender `checkPlanLimit` (`src/lib/billing/limits.ts:25-54`): cuando `dimension === 'lines'`, sumar el conteo de `whatsapp_lines` + `instagram_accounts` (dos queries `count: 'exact', head: true`, mismo shape que la existente) contra `plan.max_lines`. La dimensión `'members'` no cambia.

**Verificación:**
- Cuenta con 2 líneas de WhatsApp + 1 cuenta de Instagram en un plan con `max_lines = 3` → `checkPlanLimit(..., 'lines')` devuelve `allowed: false`.
- Test unitario nuevo en `src/lib/billing/limits.test.ts` (ya existe, mismo patrón de mocks) cubriendo el conteo combinado.

**Guardas anti-patrón:**
- No crear una dimensión `'instagram_accounts'` separada — el spec fija explícitamente un límite combinado, no uno nuevo.

---

## Fase 3 — Webhook + procesamiento de mensajes entrantes

**Qué implementar:**
1. `src/lib/contacts/dedupe-instagram.ts` (o función equivalente): `findExistingInstagramContact(db, accountId, externalId)` — lookup exacto por `(account_id, platform='instagram', external_id)` vía el índice único de la Fase 1 (no hace falta el prefiltro de sufijo que usa la versión de teléfono, acá sí hay igualdad exacta disponible).
2. `src/app/api/instagram/webhook/route.ts`:
   - `GET` — challenge/verify-token, iterando `instagram_accounts` en vez de `whatsapp_lines` (espejo de `route.ts:90-169` con la tabla cambiada).
   - `POST` — lee raw body, header `x-hub-signature-256`, llama `verifyMetaWebhookSignature` (import directo de `src/lib/whatsapp/webhook-signature.ts`, sin cambios). Resuelve la cuenta destino matcheando `recipient.id` del payload contra `instagram_accounts.instagram_business_account_id` (mismo patrón 0/1/N filas que `route.ts:248-286`).
   - `findOrCreateInstagramContact(accountId, ownerUserId, igsid, name)` — mismo patrón que `findOrCreateContact` (`route.ts:995-1053`) pero via `findExistingInstagramContact` e insert con `platform: 'instagram', external_id: igsid, phone: null`.
   - `findOrCreateInstagramConversation(accountId, ownerUserId, contactId, instagramAccountId)` — espejo de `findOrCreateConversation` (`route.ts:1055-1132`) con `instagram_account_id` en vez de `line_id`.
   - `processInstagramMessage(...)` — espejo de `processMessage` (`route.ts:565-838`) **omitiendo** los pasos de `flagBroadcastReplyIfAny`, `dispatchInboundToFlows`, disparo de automations, y `dispatchInboundToAiReply` (fuera de alcance de este sub-proyecto). Sí incluye `dispatchWebhookEvent` al final (infraestructura de webhooks salientes ya genérica de canal).

**Verificación:**
- El desafío GET de Instagram responde con el `hub.challenge` correcto cuando el `verify_token` matchea alguna fila de `instagram_accounts`.
- Un payload POST con firma inválida devuelve 401 sin tocar la DB.
- Un mensaje de texto entrante crea contacto + conversación + mensaje correctamente, sin disparar Flows/automations/IA.

**Guardas anti-patrón:**
- No llamar a Flows/automations/AI auto-reply desde `processInstagramMessage` — quedan para los sub-proyectos 3 y 4.
- No reusar `findOrCreateContact`/`findOrCreateConversation` de WhatsApp directamente — son funciones privadas del archivo de WhatsApp, acopladas a `phone`/`whatsapp_lines`.

---

## Fase 4 — Envío (Instagram Messaging API)

**Qué implementar:**
- `src/lib/instagram/meta-instagram-api.ts` (paralelo a `src/lib/whatsapp/meta-api.ts`, no lo toca): `sendInstagramText`, `sendInstagramMedia`. **Confirmar el shape exacto del request/response contra la documentación oficial de Meta (Instagram Messaging API) en el momento de implementar esta fase** — no asumir de memoria, mismo criterio que se usó con MercadoPago en el sub-proyecto de facturación.
- `src/lib/instagram/send-instagram-message.ts` (paralelo a `src/lib/whatsapp/send-message.ts`): orquesta validación + llamada a `meta-instagram-api.ts` + insert en `messages`.

**Verificación:**
- Enviar un mensaje de texto de prueba (con credenciales de un sandbox/test de Meta) llega al destinatario y la fila de `messages` queda con `status` correcto.

**Guardas anti-patrón:**
- No modificar `meta-api.ts` ni `send-message.ts` de WhatsApp — código completamente paralelo.
- No inventar el shape de la API de Instagram Messaging — verificarlo contra la documentación pública de Meta en esta fase específicamente.

---

## Fase 5 — Dispatch de envío unificado

**Qué implementar:**
- Un único punto de bifurcación en el route de envío del dashboard: resuelve `conversation_id → conversation`, y si `conversation.line_id` está seteado va por `send-message.ts` (WhatsApp), si es `conversation.instagram_account_id` va por `send-instagram-message.ts` (Fase 4).

**Verificación:**
- Enviar desde una conversación de WhatsApp sigue funcionando exactamente igual que antes (sin regresión).
- Enviar desde una conversación de Instagram usa el path nuevo.

**Guardas anti-patrón:**
- Un solo punto de bifurcación — no dispersar el chequeo `line_id` vs `instagram_account_id` por múltiples call sites.

---

## Fase 6 — UI: Settings → Instagram

**Qué implementar:**
1. `src/components/settings/instagram-accounts-panel.tsx` — copia de `WhatsAppLinesPanel` (`whatsapp-lines-panel.tsx`), tabla `instagram_accounts` en vez de `whatsapp_lines`, mismo patrón `view: 'list' | 'new' | string`.
2. `src/components/settings/instagram-config.tsx` — copia simplificada de `WhatsAppConfig`: mismo contrato de props (`{ accountId?, onSaved?, onDeleted?, onBack? }`), formulario con `name`/`instagramBusinessAccountId`/`pageId`/`accessToken` (sin PIN). **Se omiten** el bloque de "Registration Status" y la tarjeta de auto-registro de webhook (`whatsapp-config.tsx:513-614, 725-753`) — Instagram no tiene ese flujo de dos fases.
3. Ruta API `src/app/api/instagram/config/route.ts` (paralela a `src/app/api/whatsapp/config/route.ts`, simplificada — sin el paso de `/register`+PIN).
4. `useAuth()` (`src/hooks/use-auth.tsx`): agregar `instagramAccounts: InstagramAccount[]`, mismo patrón de fetch que `lines` (`:203-223`), sumado al provider value y a las dependencias del `derived` memo.
5. Registrar la sección `'instagram'` en `SETTINGS_SECTIONS`/`SECTION_META` (`src/components/settings/settings-sections.ts`) y en el `panel` map de `src/app/(dashboard)/settings/page.tsx`, mismo patrón usado para `'billing'`.

**Verificación:**
- Un admin+ puede conectar una cuenta de Instagram vía el formulario y verla aparecer en la lista.
- Un viewer/agent ve la lista en modo lectura, sin botones de agregar/editar/borrar.

**Guardas anti-patrón:**
- No copiar el bloque de Registration Status de WhatsApp — no aplica.

---

## Fase 7 — UI: inbox unificado

**Qué implementar:**
1. `ConversationItem` (`src/components/inbox/conversation-list.tsx`): ícono de canal (WhatsApp/Instagram) junto al nombre, derivado de si la conversación tiene `line_id` o `instagram_account_id`.
2. Generalizar el filtro de línea (`:189-191`, `:321-367`, `linesById` map en `:164-168`) para listar líneas de WhatsApp + cuentas de Instagram juntas en un mismo dropdown de "canal" — requiere tocar la lógica de filtro, no solo agregar un segundo dropdown (confirmado en la Fase 0 que el filtro actual es de una sola dimensión).
3. Ficha de contacto: campo condicional — si `contact.platform === 'instagram'`, mostrar `external_id`/nombre en el lugar donde hoy se muestra `phone`.

**Verificación:**
- Con cuentas de ambos canales conectadas, el dropdown de canal lista líneas de WhatsApp y cuentas de Instagram combinadas, y filtrar por una de Instagram muestra solo esas conversaciones.
- Una conversación de Instagram muestra el ícono correcto y la ficha de contacto no intenta renderizar un teléfono inexistente.

**Guardas anti-patrón:**
- No crear un segundo dropdown de filtro separado — el spec pide un filtro de canal unificado.

---

## Fase 8 — Cierre y verificación

**Qué implementar:**
1. Documentar en `.env.local.example`: si Instagram usa el mismo `META_APP_SECRET` que WhatsApp (confirmado en Fase 0 — mismo mecanismo de firma), no hace falta una variable nueva para eso; documentar solo lo que sí sea nuevo (si acaso, ninguna — la entrada de credenciales es manual por cuenta, vía UI, igual que WhatsApp).
2. Barrido: `npx tsc --noEmit`, `eslint` sobre todos los archivos nuevos/tocados, suite de tests completa.
3. Prueba manual de extremo a extremo contra una app de Meta con Instagram Messaging habilitado (sandbox/test): conectar una cuenta, recibir un DM de prueba, verificar que crea contacto+conversación+mensaje, responder desde el inbox, confirmar que llega.
4. Actualizar el README con una sección breve "Instagram (opcional)" — mismo formato que las secciones de Platform admin panel / Billing ya existentes.

**Verificación:**
- Todo lo de arriba en verde.
- `next build` compila (mismo criterio de cierre usado en todos los sub-proyectos anteriores).

**Guardas anti-patrón:**
- No dar por cerrada la Fase 3 (webhook) ni la Fase 4 (envío) solo con tests automatizados — el flujo real contra la API de Instagram Messaging de Meta es el único modo de confirmar que el shape asumido es correcto, mismo criterio que se usó con MercadoPago y con la impersonación del panel de admin.
