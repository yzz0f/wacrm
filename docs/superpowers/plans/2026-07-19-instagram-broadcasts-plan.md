# Plan de implementación: Instagram — Broadcasts (sub-proyecto 2 de 4)

**Spec:** `docs/superpowers/specs/2026-07-19-instagram-broadcasts-design.md`

---

## Fase 0 — Hechos verificados

**Migraciones:** última en `main` es `043_instagram_foundation.sql`. Esta fase usa `044_instagram_broadcasts.sql` — confirmar contra el estado real al implementar.

**Arquitectura real de broadcasts de WhatsApp — dos caminos distintos, no uno:**
1. **Dashboard wizard** (`src/hooks/use-broadcast-sending.ts`): 100% orquestado en el cliente. El hook crea la fila `broadcasts` directo vía Supabase (`:358-382`), inserta `broadcast_recipients` en lotes (`:391-410`), y por cada lote de destinatarios llama a `POST /api/whatsapp/broadcast` (`:481-486`) — una ruta **stateless** (`src/app/api/whatsapp/broadcast/route.ts`, confirmado leyendo el archivo completo: no toca `broadcasts`/`broadcast_recipients` en absoluto, solo hace fan-out síncrono contra Meta y devuelve resultados por teléfono) — y actualiza las filas de recipients/counts en el cliente a medida que llegan resultados.
2. **API pública** (`src/lib/whatsapp/broadcast-core.ts`, usada por `/api/v1/broadcasts`): server-side, `createBroadcast()` + `deliverBroadcast()`, todo en el backend.

**Decisión de simplificación para Instagram (justificada, no un descuido):** el flujo cliente-orquestado de WhatsApp existe principalmente para soportar personalización por destinatario (variables de template resueltas contacto-por-contacto) a gran escala. Los broadcasts de Instagram de esta fase son texto libre **sin variables por destinatario** — el mismo mensaje para todos. Por eso este plan implementa solo el camino server-side (patrón `broadcast-core.ts`), sin replicar el hook cliente-orquestado de WhatsApp — mucho menos código, y arquitectónicamente correcto dado que no hay nada que personalizar por fila.

**`broadcasts` — columnas relevantes ya existentes** (`001_initial_schema.sql:294-312`, `017_account_sharing.sql:185`, `037_whatsapp_lines.sql:132`, `038_whatsapp_lines_finalize.sql:148`): `id, user_id, account_id, line_id (NOT NULL), name, template_name (NOT NULL), template_language, template_variables, audience_filter, scheduled_at, status, total_recipients, sent_count, delivered_count, read_count, replied_count, failed_count`.

**`broadcast_recipients`** (`001_initial_schema.sql:321-332`): `id, broadcast_id, contact_id, status, sent_at, delivered_at, read_at, replied_at, error_message, created_at`. Sin cambios necesarios — el modelo de status/error ya es genérico.

**Conteos agregados** — mantenidos por un trigger de DB (mencionado en comentarios de `broadcast-core.ts:188-195, 317-319`), no se escriben a mano salvo el `status` terminal — mismo patrón a seguir para Instagram.

---

## Fase 1 — Esquema

**Qué implementar** (`044_instagram_broadcasts.sql`):
```sql
ALTER TABLE broadcasts
  ALTER COLUMN line_id DROP NOT NULL,
  ALTER COLUMN template_name DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS instagram_account_id UUID REFERENCES instagram_accounts(id),
  ADD COLUMN IF NOT EXISTS message_text TEXT;

ALTER TABLE broadcasts ADD CONSTRAINT one_channel_account_broadcast CHECK (
  (line_id IS NOT NULL AND instagram_account_id IS NULL) OR
  (line_id IS NULL AND instagram_account_id IS NOT NULL)
);
```
Mismo patrón que `conversations`/`instagram_account_id` de la Fundación (migración `043`).

**Verificación:** insertar un broadcast con `instagram_account_id` seteado y `line_id`/`template_name` en NULL no rompe ningún constraint; insertar uno con ambos `line_id` e `instagram_account_id` en NULL falla por el CHECK.

**Guardas anti-patrón:** no tocar `broadcast_recipients` — no lo necesita.

---

## Fase 2 — Audiencia alcanzable (ventana de 24h)

**Qué implementar:**
- `src/lib/instagram/reachable-audience.ts` — `getInstagramReachableContacts(db, accountId, instagramAccountId): Promise<Contact[]>`. Query: contactos con `platform = 'instagram'` que tengan al menos una fila en `messages` con `sender_type = 'customer'` y `created_at >= now() - interval '24 hours'`, en una conversación de esa `instagram_account_id`. **No usar `conversations.last_message_at`** — esa columna se actualiza también en envíos salientes (`src/app/api/instagram/webhook/route.ts:394`, `src/lib/instagram/send-instagram-message.ts:148`), así que no distingue "el contacto me escribió" de "yo le respondí".

**Verificación:** un contacto cuyo único mensaje entrante fue hace 30 horas no aparece; uno con un mensaje entrante hace 2 horas sí, incluso si el agente ya le respondió (lo que actualizó `last_message_at` pero no crea una fila `sender_type='customer'` nueva).

**Guardas anti-patrón:** no filtrar por `conversations.last_message_at` — es la trampa específica que este plan ya identificó y evitó en el spec.

---

## Fase 3 — Envío

**Qué implementar:**
- `src/lib/instagram/broadcast-instagram-core.ts` (paralelo a `broadcast-core.ts`, patrón server-side, no el hook cliente-orquestado de WhatsApp — ver Fase 0):
  - `createInstagramBroadcast(db, accountId, params: { name, messageText, instagramAccountId, contactIds })` — valida `messageText` no vacío, crea la fila `broadcasts` (`message_text`, `instagram_account_id`, `template_name: null`), inserta `broadcast_recipients` en estado `pending`.
  - `deliverInstagramBroadcast(db, plan)` — fan-out simple sobre `sendInstagramText` (sin reintento de variantes — no aplica a un IGSID). En cada fallo, si `isOutsideMessagingWindowError(err)` (ya existe en `meta-instagram-api.ts`), marca `error_message = 'Outside the 24-hour messaging window'`; cualquier otro error usa el mensaje real. Actualiza `status` terminal en `broadcasts` al final (`sent` si `sentCount > 0`, si no `failed`) — igual criterio que `deliverBroadcast` (`broadcast-core.ts:320-326`), sin tocar los contadores agregados (trigger-owned).
- `src/app/api/instagram/broadcast/route.ts` — `POST`, body `{ name, message_text, instagram_account_id?, contact_ids }` (si `instagram_account_id` se omite, usa la cuenta de Instagram default). Llama `createInstagramBroadcast` + `deliverInstagramBroadcast` en la misma request (dado que no hay problema de escala con texto libre sin `after()` — a diferencia de webhooks entrantes, esta es una acción iniciada por el usuario que puede esperar la respuesta).

**Verificación:**
- Un broadcast a 3 contactos alcanzables se marca `sent`, con 3 filas `broadcast_recipients` en `sent`.
- Un contacto fuera de ventana entre los seleccionados queda `failed` con el mensaje de ventana, sin abortar el resto del batch.

**Guardas anti-patrón:**
- No escribir a mano los contadores agregados de `broadcasts` (`sent_count`, etc.) — son trigger-owned, mismo criterio que WhatsApp.
- No reintentar variantes de destinatario — un IGSID no tiene variantes.

---

## Fase 4 — UI

**Qué implementar:**
1. `src/components/broadcasts/step1-choose-template.tsx` gana una rama: si el canal elegido (mismo selector ya generalizado en la Fundación) es una cuenta de Instagram, se oculta el picker de templates y se muestra un `Textarea` de mensaje libre en su lugar.
2. `src/components/broadcasts/step2-select-audience.tsx`: cuando el canal es Instagram, la lista de contactos disponibles se resuelve vía `getInstagramReachableContacts` (Fase 2) en vez de la resolución de audiencia genérica de WhatsApp — los filtros de tag/empresa existentes siguen aplicando *sobre* ese conjunto ya acotado.
3. `src/app/(dashboard)/broadcasts/new/page.tsx` / el hook de envío: rama de canal — si es Instagram, POST a `/api/instagram/broadcast` (Fase 3) en vez del flujo cliente-orquestado de `use-broadcast-sending.ts`.
4. Lista de broadcasts (`src/app/(dashboard)/broadcasts/page.tsx` y el detalle): mostrar el nombre del canal (WhatsApp line o cuenta de Instagram) igual que ya se generalizó en conversaciones — reusar `channelNameById`-style lookup.

**Verificación:**
- Armar un broadcast de Instagram de punta a punta desde la UI: elegir cuenta → escribir mensaje → ver solo contactos alcanzables → enviar → ver resultados por destinatario.

**Guardas anti-patrón:**
- No agregar personalización por variable a los broadcasts de Instagram en esta fase — fuera de alcance del spec (texto libre igual para todos).

---

## Fase 5 — Cierre y verificación

**Qué implementar:**
1. Barrido: `npx tsc --noEmit`, `eslint`, suite de tests completa (agregar tests para `getInstagramReachableContacts` y `createInstagramBroadcast`/`deliverInstagramBroadcast` con fetch mockeado, mismo patrón que `meta-instagram-api.test.ts`).
2. Prueba manual: broadcast real contra una cuenta de Instagram de prueba con al menos un contacto dentro y uno fuera de la ventana de 24h, confirmar que el reporte de resultados distingue ambos casos correctamente.
3. Actualizar el README, sección "Instagram (optional)" — sumar una línea sobre broadcasts ahora soportados con sus límites (sin templates, ventana de 24h).

**Verificación:** todo lo de arriba en verde; `next build` compila.

**Guardas anti-patrón:** no dar la Fase 3 por cerrada solo con tests — el error exacto de "fuera de ventana" (`isOutsideMessagingWindowError`) sigue sin confirmación oficial de Meta (heredado de la Fundación), así que la prueba manual es la única forma de saber si ese camino de error realmente dispara como se espera.
