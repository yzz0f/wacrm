# Plan de implementación: Multi-número por cuenta (WhatsApp "Lines")

**Spec:** `docs/superpowers/specs/2026-07-18-multi-number-lines-design.md`
**Alcance:** Sub-proyecto 1 de 2. No incluye el panel de super-admin (spec hermano, plan aparte).

Cada fase está pensada para ejecutarse en una sesión nueva. Cita archivo:línea del código actual (verificado por lectura directa, no de memoria) para que cada tarea sea "copiar/adaptar", no "inventar".

---

## Fase 0 — Hechos verificados (no releer, ya confirmado)

**RLS / esquema:**
- `is_account_member(target_account_id, min_role)` — `supabase/migrations/017_account_sharing.sql:136-166`. No se modifica su firma en este sub-proyecto (la usan ~15 tablas sin relación con líneas).
- Plantilla de las 4 políticas RLS por tabla (ejemplo `whatsapp_config`) — `017_account_sharing.sql:419-424`.
- DDL original de `whatsapp_config` — `001_initial_schema.sql:190-202`. Columnas agregadas después: `registered_at`/`subscribed_apps_at`/`last_registration_error` por `015_whatsapp_config_registration.sql:36-39`; `UNIQUE(phone_number_id)` por `013_whatsapp_config_phone_number_id_unique.sql:80-83`; `account_id` + `UNIQUE(account_id)` + las 4 políticas por `017_account_sharing.sql`.
- Patrón para `ADD CONSTRAINT` guardado (Postgres no tiene `IF NOT EXISTS` para constraints) — `013_whatsapp_config_phone_number_id_unique.sql:70-84`.
- Patrón de preflight `DO $$ ... RAISE EXCEPTION` para detectar duplicados antes de una migración de datos — `013_whatsapp_config_phone_number_id_unique.sql:37-68`.
- `idx_accounts_one_per_owner` (una cuenta = un owner) — `017_account_sharing.sql:73-74`. Confirma que "impersonar como el owner" (spec 2) no tiene ambigüedad, y que backfill de `line_access` puede iterar `profiles` sin preocuparse por múltiples owners.
- **Siguiente número de migración: `037_*.sql`** (el más alto existente es `036_conversation_contact_dedup.sql`).

**Puntos de envío — todos filtran `whatsapp_config` por `account_id` con `.single()`/`.maybeSingle()` excepto el webhook (por `phone_number_id`):**
- Webhook: `src/app/api/whatsapp/webhook/route.ts:255-285` (lookup), `:289-305` (llamada a `processMessage`), `:560-572` (firma de `processMessage`, función local no exportada). También el handler `GET` de verificación (`:104-156`) hace su propio scan de `whatsapp_config` — no estaba en la lista del spec, agregarlo.
- `src/lib/whatsapp/send-message.ts:250-263` (config fetch), `:314-321` (template fetch), `:221-226` (conversation fetch — de aquí sale `line_id`). Firma: `:183-187`.
- `src/lib/whatsapp/broadcast-core.ts:114-126` (config fetch), `:130-144` (template fetch). Firma `createBroadcast`: `:85-90` — **no tiene parámetro `lineId` hoy, hay que agregarlo, no renombrar nada existente.**
- `src/lib/automations/meta-send.ts:134-141` (config fetch, dentro de `sendViaMeta` privada). Args interfaces sin `lineId`: `:27-49`.
- `src/lib/flows/meta-send.ts` — **3 fetches independientes** (no comparten un `sendViaMeta` común como automations): `:85-92` (`engineSendText`), `:195-202` (`engineSendMedia`), `:347-354` (`sendInteractiveViaMeta`, privada, compartida por buttons/list).
- `src/lib/whatsapp/template-send-builder.ts` — **no toca la DB**, función pura (`buildSendComponents`, `:219-222`). No requiere cambios; el spec lo lista porque sus *llamadores* sí cambian.
- `src/app/api/whatsapp/broadcast/route.ts:137-153` (config fetch), `:160-176` (template fetch). **Esta ruta no inserta en `broadcasts` hoy** (a diferencia de `broadcast-core.ts`) — envía sincrónicamente por destinatario.
- `src/app/api/whatsapp/react/route.ts:111-126` (config fetch, columnas limitadas `phone_number_id, access_token`), `:87-92` (conversation fetch, de aquí sale `line_id`).
- `src/types/index.ts:269-288` — `WhatsAppConfig` no tiene `account_id` ni `name`/`is_default` pese a que todo el código filtra por `account_id`.

**Descubrimiento adicional (no estaba en el spec — 12 archivos más que leen `whatsapp_config` por `account_id` con `.single()`/`.maybeSingle()`, y que romperán silenciosamente — devuelven una fila arbitraria, no un error — en cuanto exista más de una línea por cuenta):**
- `src/app/api/whatsapp/config/route.ts` (se convierte en el CRUD de líneas)
- `src/app/api/whatsapp/config/verify-registration/route.ts:59`
- `src/app/api/whatsapp/templates/submit/route.ts:153`
- `src/app/api/whatsapp/templates/[id]/route.ts:142,282`
- `src/app/api/whatsapp/templates/sync/route.ts:154`
- `src/app/api/whatsapp/media/[mediaId]/route.ts:53`
- `src/lib/whatsapp/resolve-conversation.ts:59` — **este es el sitio real de la decisión de producto #5 del spec** ("conversación nueva iniciada manualmente usa la línea `is_default`") — no estaba identificado en el spec, es donde debe implementarse.
- `src/lib/api/v1/contacts.ts:77` (dentro de `resolveAuditUserId`, fallback de auditoría — no es un send site pero sí un consumidor a actualizar)
- Tests: `src/app/api/whatsapp/send/route.test.ts`, `src/lib/whatsapp/resolve-conversation.test.ts` (fixtures a actualizar)

**UI — Settings/Team:**
- `src/components/settings/whatsapp-config.tsx` (840 líneas) — plantilla completa a parametrizar por `lineId` en vez de `accountId`. Bloques: estado (`:49-90`), fetch (`:97-166`, hoy `.eq('account_id', acctId).maybeSingle()` en `:106-110`), `handleSave` (`:185-278`), Cards de credenciales (`:558-654`) y webhook (`:657-684`).
- `src/components/settings/settings-overview.tsx:120-137` — tile de estado de WhatsApp, también asume una sola fila por `account_id`.
- `src/components/settings/members-tab.tsx` — roster de miembros (`:325-474`) y bloque de invitaciones pendientes (`:477-561`) son la plantilla a copiar para la nueva sección "Acceso por línea" (se agrega después de `:561`, mismo patrón `Card` + lista + `RequireRole min="admin"`).
- Guard "no se puede eliminar si tiene dependientes" — `src/components/pipelines/pipeline-settings.tsx:164-183` (`handleRemoveStage`): pre-check `count: "exact", head: true` sobre la tabla dependiente, `toast.error` si `count > 0`. Replicar para "línea con conversaciones activas" (`conversations` filtrado por `line_id`).
- `src/types/index.ts:13-49` (`Profile`), `:55-62` (`Account`), `:71-78` (`AccountMember`), `:86-97` (`AccountInvitation`) — no existe ningún tipo de `line_access` hoy, es una adición completamente nueva.

**UI — Inbox/Broadcasts/Automations/Flows:**
- `src/components/inbox/conversation-list.tsx:308-352` — filtro de "Company" (dropdown condicional a `companies.length > 0`) es la plantilla exacta a copiar para el filtro de línea (condicional a `lines.length > 1`), insertado como hermano dentro de la fila `flex flex-wrap items-center gap-1` (`:239`). Badge de línea en la fila: junto al status dot, `:492-498`, dentro de `ConversationItem` (`:433-504`).
- `src/app/(dashboard)/broadcasts/new/page.tsx:17-22` — lista de steps del wizard, sin registro compartido; agregar un step nuevo antes de `'template'` significa renumerar las condiciones `currentStep === N` en `:191-230`.
- `src/components/broadcasts/step1-choose-template.tsx:29-52` — fetch de `message_templates`, hoy sin filtro de `line_id` (solo `status === 'APPROVED'`), dep array `[]` a cambiar por `[lineId]`.
- `src/components/automations/automation-builder.tsx:783-886` (`TriggerCard`) — punto de inserción del selector opcional de línea: después del `<select>` de `triggerType` (`:826-836`), antes de los bloques de config por tipo (`:841+`). Patrón de estado: `patchTop("trigger_type", ...)` (`:634-636`); payload de guardado `:666-673`.
- `src/components/flows/flow-builder.tsx:264-341` (`TriggerPanel`, solo vista lista) — inserción dentro del grid `grid-cols-1 md:grid-cols-2` (`:278-309`), como tercera celda. Estado compartido en `BuilderState` (`src/components/flows/flow-editor-state.tsx:61-69`), payload `:318-319`/`:341-342`.
- `src/hooks/use-auth.tsx` — única fuente de contexto account-scoped en la app (confirmado por grep, cero hits de "lines"/"whatsapp_config" en `src/hooks/`). `AccountSummary` (`:40-46`) y `AuthContextValue` (`:81-90`) no cargan líneas hoy. `fetchProfile` (`:133-226`) es el lugar natural para agregar el fetch de `whatsapp_lines` + derivar `hasSingleLine` (mismo patrón que el `useMemo` de `:321-334`). El objeto de fallback fuera de `<AuthProvider>` (`:366-387`) necesita `lines: []`/`hasSingleLine: false` por consistencia fail-closed.

**Gaps que cada fase de UI debe cerrar leyendo el código antes de escribir (no verificados aún por los agentes de descubrimiento):**
- `src/lib/inbox/conversations.ts` (`CONVERSATION_SELECT`, tipo `Conversation`) — necesario para saber cómo threadear `line_id`/nombre de línea hacia el badge del inbox.
- `src/app/(dashboard)/broadcasts/[id]/page.tsx` y el hook de envío de broadcasts — necesario para que `line_id` llegue también al *envío* real, no solo al borrador.
- Rutas API de automations/flows (`src/app/api/automations/...`, equivalente en flows) — confirmar que aceptan/validan un `line_id` nuevo en el body.

---

## Fase 1 — Esquema: tabla `whatsapp_lines` + migración de datos

**Qué implementar:**
1. Nueva migración `supabase/migrations/037_whatsapp_lines.sql`.
2. `CREATE TABLE whatsapp_lines` — copiar la forma final de `whatsapp_config` tal como quedó tras 001+013+015+017 (todas las columnas listadas en Fase 0), agregando `name TEXT NOT NULL DEFAULT 'Línea principal'` y `is_default BOOLEAN NOT NULL DEFAULT false`. `UNIQUE(phone_number_id)` global (igual que hoy). Índice en `account_id`. Índice único parcial: `CREATE UNIQUE INDEX ... ON whatsapp_lines(account_id) WHERE is_default` (garantiza una sola default por cuenta) — seguir el patrón guardado de `013:70-84` si hace falta un `DO $$` de verificación previa.
3. Migrar datos: `INSERT INTO whatsapp_lines SELECT ... , 'Línea principal', true FROM whatsapp_config`.
4. Habilitar RLS en `whatsapp_lines` y copiar las 4 políticas de `017:419-424` verbatim, cambiando el nombre de tabla — mismo nivel de acceso que hoy (`admin` para insert/update/delete, cualquier miembro para select).
5. Agregar `line_id UUID REFERENCES whatsapp_lines(id)` **nullable** a `conversations`, `message_templates`, `broadcasts`. Backfill: cada fila toma el `id` de la única línea de su `account_id` (subquery). Automations/flows: agregar `line_id` **nullable, sin backfill** (queda `NULL` = todas las líneas).
6. Nueva tabla `line_access (line_id UUID REFERENCES whatsapp_lines(id), profile_id UUID REFERENCES profiles(id), PRIMARY KEY(line_id, profile_id))`, RLS: solo lectura/escritura para `is_account_member(account_id_de_la_línea, 'admin')` (join a `whatsapp_lines` para resolver `account_id`).
7. Backfill de `line_access`: una fila por cada `profiles` con `account_role IN ('agent','viewer')` × la línea migrada de su cuenta (para no dejar a nadie sin acceso el día del cambio, según el spec).
8. Nueva función `can_access_line(target_line_id UUID) RETURNS BOOLEAN` (`SECURITY DEFINER`, `SET search_path = public`): `true` si `is_account_member((SELECT account_id FROM whatsapp_lines WHERE id = target_line_id), 'admin')`, o si existe fila en `line_access` para `(target_line_id, (SELECT id FROM profiles WHERE user_id = auth.uid()))`. **Nota de diseño**: se agrega como función nueva que reutiliza `is_account_member`, en vez de modificar `is_account_member` directamente — así el cambio queda contenido a las tablas que realmente necesitan granularidad por línea (`conversations`/`messages`), sin tocar las ~13 tablas restantes que llaman `is_account_member` sin ningún concepto de línea.
9. Actualizar las políticas de `conversations` (y de `messages`, vía `EXISTS` a su conversation) para además exigir `can_access_line(line_id)` cuando el rol es exactamente `agent` o `viewer` (los `admin`/`owner` ya pasan por la primera condición de `can_access_line`, así que una sola cláusula `is_account_member(account_id,'agent') AND can_access_line(line_id)` cubre ambos casos sin duplicar lógica).
10. Una vez verificado en un entorno de prueba: `ALTER TABLE conversations/message_templates/broadcasts ALTER COLUMN line_id SET NOT NULL` (fase separada, ver Fase 10).

**Referencias:** ver Fase 0 — RLS/esquema.

**Verificación:**
- `supabase db reset` (o el flujo de migración local del proyecto) corre sin errores.
- Una cuenta de prueba con datos existentes queda con exactamente 1 fila en `whatsapp_lines` (`is_default = true`) y todas sus `conversations`/`message_templates`/`broadcasts` con `line_id` poblado.
- Cada `profiles` agent/viewer de esa cuenta tiene 1 fila en `line_access` apuntando a esa línea.
- `SELECT * FROM conversations` como un agente sin fila en `line_access` para otra línea (crear una segunda línea de prueba) → no debe ver conversaciones de esa segunda línea.

**Guardas anti-patrón:**
- No modificar la firma de `is_account_member()` — usarla tal cual, solo desde dentro de `can_access_line()`.
- No usar `ADD CONSTRAINT` sin el guard `IF NOT EXISTS (SELECT 1 FROM pg_constraint ...)` — Postgres no tiene soporte nativo, seguir el patrón de `013:70-84`.
- No poner `NOT NULL` en `line_id` hasta después del backfill verificado (Fase 10), o la migración falla en cualquier entorno con datos existentes.

---

## Fase 2 — Webhook: routing por línea

**Qué implementar:**
1. En `src/app/api/whatsapp/webhook/route.ts`, cambiar el lookup de `:255-285` de `whatsapp_config` a `whatsapp_lines` (mismo filtro `.eq('phone_number_id', phoneNumberId)`, misma lógica de 0/1/N filas).
2. Cambiar el handler `GET` de verificación (`:104-156`) del mismo modo (scan de `whatsapp_lines` en vez de `whatsapp_config`).
3. Extender la llamada a `processMessage` (`:293-305`) para pasar `config.id` (el `line_id`) como parámetro adicional.
4. Extender la firma de `processMessage` (`:560-572`) para recibir `lineId: string`.
5. Dentro de `processMessage`, threadear `lineId` hacia `findOrCreateConversation` (definida en `:1044`) y hacia el `INSERT` de conversación (`:1081-1089`) — agregar `line_id: lineId` al payload del insert. Si la conversación ya existe (no se crea), no se toca su `line_id` (una conversación no cambia de línea).

**Referencias:** Fase 0 — bloque de "Puntos de envío".

**Verificación:**
- Con 2 líneas de prueba bajo la misma cuenta, un mensaje entrante a cada número crea/actualiza conversaciones con el `line_id` correcto.
- Un `phone_number_id` que no matchea ninguna línea (línea borrada o mal configurada) → el webhook responde `200`, no lanza excepción, se loguea (comportamiento ya existente para 0 filas, solo cambia la tabla consultada).
- El handler `GET` de verificación sigue encontrando el `verify_token` correcto contra `whatsapp_lines`.

**Guardas anti-patrón:**
- No asumir que `configRows.length > 1` es imposible — mantener el logging de error existente para esa rama (post-migración `UNIQUE(phone_number_id)` sigue vigente, pero filas pre-constraint podrían existir en despliegues viejos).
- No crear una conversación nueva para un mensaje de una conversación ya existente — solo estampar `line_id` en el `INSERT`, nunca en un `UPDATE` de una conversación preexistente.

---

## Fase 3 — Puntos de envío principales (mensajes, broadcasts, automations, flows)

**Qué implementar:**
1. `src/lib/whatsapp/send-message.ts`: usar el `line_id` ya disponible en la fila de `conversation` (fetch existente en `:221-226`) para reemplazar el fetch de `whatsapp_config` por `account_id` (`:250-263`) con un fetch de `whatsapp_lines` por `id = conversation.line_id`. Igual para el fetch de `message_templates` (`:314-321`): agregar `.eq('line_id', conversation.line_id)`.
2. `src/lib/whatsapp/broadcast-core.ts`: agregar parámetro `lineId: string` a `createBroadcast` (`:85-90`) — no existe hoy, es una adición pura. Usarlo para reemplazar el fetch de `whatsapp_config` (`:114-126`) y el de `message_templates` (`:130-144`), ambos con `.eq('line_id', lineId)` o `.eq('id', lineId)` según corresponda. `deliverBroadcast` (`:262-265`) recibe el `line_id` a través del `BroadcastPlan` ya resuelto en `createBroadcast`, no necesita su propio parámetro nuevo si `BroadcastPlan` lo incluye.
3. `src/lib/automations/meta-send.ts`: dentro de `sendViaMeta` (`:134-141`), resolver `line_id` desde la `conversation` asociada a `input.conversationId` (nuevo fetch, ya que hoy este archivo no toca `conversations` — confirmar antes de escribir) y usarlo en vez de `input.accountId` para el fetch de `whatsapp_lines`.
4. `src/lib/flows/meta-send.ts`: mismo tratamiento en los 3 sitios (`:85-92`, `:195-202`, `:347-354`) — cada uno resuelve `line_id` desde la conversación del flow run.
5. `template-send-builder.ts`: sin cambios (función pura, confirmado en Fase 0).

**Referencias:** Fase 0 — bloque de "Puntos de envío".

**Verificación:**
- Con 2 líneas con credenciales/WABA distintas en la misma cuenta de prueba: enviar un mensaje manual, un broadcast, disparar una automatización y un flow, cada uno desde una conversación de una línea distinta — verificar en los logs de Meta (o en un mock de la API) que cada envío usa el `access_token`/`phone_number_id` de la línea correcta, no de "la primera fila que encuentre".
- Los tests existentes (`send/route.test.ts`, `resolve-conversation.test.ts`) actualizados y en verde (ver Fase 10 para el barrido completo de fixtures).

**Guardas anti-patrón:**
- No dejar ningún `.eq('account_id', ...)` sin reemplazar en los fetches de `whatsapp_config`/`whatsapp_lines` de estos 4 archivos — grep `whatsapp_config` en los 4 archivos debe devolver cero resultados al terminar esta fase (la tabla ya no existe bajo ese nombre para entonces si Fase 1 ya corrió, así que esto también es una verificación de compilación).
- No asumir que `conversationId`/`conversation.line_id` siempre existe sin manejar el caso `null` — decidir explícitamente qué pasa si una conversación quedó sin `line_id` (no debería ocurrir tras el backfill de Fase 1, pero la función debe fallar con un error claro, no silenciosamente a la primera línea de la cuenta).

---

## Fase 4 — Call sites adicionales descubiertos (no estaban en el spec original)

**Qué implementar:** actualizar cada uno de estos para resolver por línea en vez de por cuenta:
1. `src/app/api/whatsapp/config/route.ts` — se convierte en el CRUD de líneas: `GET`/`POST`/`DELETE` reciben `line_id` (query param o body) en vez de resolver "la única fila de la cuenta". `POST` sin `line_id` = crear una línea nueva.
2. `src/app/api/whatsapp/config/verify-registration/route.ts:59` — filtrar por `line_id`.
3. `src/app/api/whatsapp/templates/submit/route.ts:153`, `templates/[id]/route.ts:142,282`, `templates/sync/route.ts:154` — las plantillas ya están ancladas a `line_id` desde Fase 1; estas rutas deben resolver credenciales por el `line_id` de la plantilla en cuestión, no por `account_id`.
4. `src/app/api/whatsapp/media/[mediaId]/route.ts:53` — el proxy de media necesita el `access_token` de la línea correcta; resolver `line_id` desde el mensaje/conversación al que pertenece el media.
5. `src/lib/whatsapp/resolve-conversation.ts:59` — **aquí se implementa la decisión de producto #5 del spec**: al crear una conversación nueva manualmente (sin mensaje entrante previo), usar la línea `is_default` de la cuenta; si la cuenta tiene más de una línea, aceptar un `line_id` explícito como override.
6. `src/lib/api/v1/contacts.ts:77` (`resolveAuditUserId`) — actualizar el fallback para no asumir una sola fila de `whatsapp_config`/`whatsapp_lines` por cuenta.
7. `src/app/api/whatsapp/broadcast/route.ts:137-153,160-176` y `src/app/api/whatsapp/react/route.ts:111-126` — mismo tratamiento que Fase 3 (resolver por `line_id` de la conversación/request, no por `account_id`).

**Referencias:** Fase 0 — bloque "Descubrimiento adicional".

**Verificación:**
- Grep repo-wide de `whatsapp_config` (después de que Fase 1 rebautizó la tabla) devuelve cero resultados fuera de comentarios históricos/changelog.
- Cada ruta de la lista probada individualmente con una cuenta de 2 líneas — ninguna debe devolver silenciosamente los datos de la línea equivocada.

**Guardas anti-patrón:**
- No dejar ninguno de estos 7 puntos "para después" asumiendo que son de bajo tráfico — todos son lecturas `.single()`/`.maybeSingle()` que hoy devuelven una fila arbitraria sin error en cuanto exista más de una línea, es un bug de correctitud silencioso, no un error de compilación que se note solo.

---

## Fase 5 — UI: Configuración → Líneas

**Qué implementar:**
1. Nuevo componente de lista `src/components/settings/whatsapp-lines-list.tsx` (o similar) — plantilla de estructura: roster de `members-tab.tsx:325-474` (Card + `<ul className="divide-y divide-border">` + fila por entidad con acción a la derecha), adaptado a: nombre de línea, número, badge de estado, badge "predeterminada", botón "Editar"/"Completar registro" según estado.
2. Parametrizar `whatsapp-config.tsx` existente para recibir `lineId` (en vez de resolver implícitamente "la config de esta cuenta"): cambiar el fetch de `:106-110` de `.eq('account_id', acctId).maybeSingle()` a `.eq('id', lineId).single()`, y las llamadas a `/api/whatsapp/config` (Fase 4, punto 1) para incluir `line_id`.
3. Botón "+ Agregar línea" en la lista → abre el mismo formulario de `whatsapp-config.tsx` en modo creación (sin `lineId`).
4. Guard de eliminación: replicar `pipeline-settings.tsx:164-183` — pre-check `count` de `conversations` filtrado por `line_id`, bloquear con toast si `count > 0`, sugerir archivar (`status = 'disconnected'`) en vez de eliminar.
5. Actualizar `settings-overview.tsx:120-137` (tile de estado) para reflejar "N líneas conectadas de M" en vez de un booleano único.
6. Registrar la nueva sección en la navegación de Settings (revisar `settings-sections.ts`/`settings-rail.tsx` — no inspeccionado aún por los agentes, leer antes de tocar el nav).

**Referencias:** Fase 0 — bloque "UI — Settings/Team".

**Verificación:**
- Cuenta con 1 línea: la UI se ve funcionalmente igual que hoy (mismo formulario), solo con el nombre de sección cambiado.
- Cuenta con 2+ líneas: la lista muestra ambas, cada una editable independientemente, sin que guardar una afecte a la otra.
- Intentar eliminar una línea con conversaciones activas → bloqueado con el mensaje esperado.

**Guardas anti-patrón:**
- No reescribir `whatsapp-config.tsx` desde cero — parametrizarlo (agregar prop `lineId`, cambiar las 2-3 queries que asumen cuenta única), reusar el 95% del archivo tal cual.
- No inventar un componente `Badge` que no exista en el proyecto — este archivo usa `<span>` con clases Tailwind para badges de estado (confirmado, no importa `Badge` de `@/components/ui`), seguir esa convención en la nueva lista.

---

## Fase 6 — UI: Acceso por línea (Team members)

**Qué implementar:**
1. Nueva sección en `members-tab.tsx`, insertada después del bloque de invitaciones pendientes (`:561`), mismo patrón: `Card` + lista + `RequireRole min="admin"`.
2. Lista de miembros filtrada a `role IN ('agent', 'viewer')` (owners/admins no participan de `line_access` — bypass total, no se muestran aquí).
3. Por cada miembro filtrado: checkboxes o multi-select de líneas de la cuenta, reflejando/escribiendo en `line_access`.
4. Nueva ruta API (`/api/account/line-access` o similar) para leer/escribir `line_access`, protegida por `is_account_member(account_id, 'admin')`.
5. Nuevo tipo en `src/types/index.ts` (no existe hoy, confirmado): `LineAccess { line_id: string; profile_id: string }` o el shape que la nueva ruta API devuelva.

**Referencias:** Fase 0 — bloque "UI — Settings/Team".

**Verificación:**
- Un admin asigna a un agente solo la línea "Soporte" → ese agente deja de ver conversaciones de "Ventas" en el inbox (verificación cruzada con la RLS de Fase 1).
- Un agente sin ninguna asignación no ve ninguna línea (deny-by-default, confirmado en el spec).

**Guardas anti-patrón:**
- No mostrar owners/admins en esta UI como si necesitaran asignación — confundiría el modelo (ellos ya ven todo siempre).

---

## Fase 7 — UI: Inbox (filtro y badge por línea)

**Qué implementar:**
1. **Antes de escribir código**: leer `src/lib/inbox/conversations.ts` (`CONVERSATION_SELECT`, tipo `Conversation`) — gap identificado en el descubrimiento, no verificado aún. Confirmar cómo agregar `line_id`/nombre de línea al select y al tipo.
2. Extender `useAuth()` (`src/hooks/use-auth.tsx`): agregar fetch de `whatsapp_lines` (filtrado por `line_access` si el rol es agent/viewer, todas si es admin/owner — mismo patrón que `fetchProfile`, `:133-226`) y exponer `lines: WhatsappLine[]` + `hasSingleLine: boolean` derivado (mismo patrón que el `useMemo` de `:321-334`). Agregar `lines: []`/`hasSingleLine: false` al objeto de fallback (`:366-387`).
3. Filtro de línea en `conversation-list.tsx`: copiar el dropdown de "Company" (`:308-352`, condicional a `companies.length > 0`) adaptado a `lines.length > 1`, insertado en la fila `:239`.
4. Badge de línea en cada fila: junto al status dot (`:492-498`), dentro de `ConversationItem`.
5. Extender la lógica de filtrado (`:161-191`) con la nueva condición de línea seleccionada.

**Referencias:** Fase 0 — bloque "UI — Inbox/Broadcasts/Automations/Flows".

**Verificación:**
- Cuenta con 1 línea: ni el filtro ni el badge aparecen (oculto por completo, confirmado en el diseño aprobado).
- Cuenta con 2+ líneas: filtro funcional, badge visible y correcto en cada conversación.

**Guardas anti-patrón:**
- No mostrar el filtro/badge condicionado solo a "la cuenta tiene la feature habilitada" — la condición real es `lines.length > 1`, calculada, no un flag separado.

---

## Fase 8 — UI: Broadcasts (selector de línea)

**Qué implementar:**
1. **Antes de escribir código**: leer `src/app/(dashboard)/broadcasts/[id]/page.tsx` y el hook de envío de broadcasts (gap identificado, no verificado aún) — confirmar que `line_id` se puede threadear también hacia el envío real, no solo hacia el borrador.
2. Nuevo step en el wizard (`src/app/(dashboard)/broadcasts/new/page.tsx:17-22`), antes de `'template'` — solo se muestra si `lines.length > 1` (si la cuenta tiene 1 línea, se preselecciona automáticamente y el step se salta).
3. `step1-choose-template.tsx:29-52`: agregar `.eq('line_id', lineId)` al fetch de `message_templates`, cambiar dep array de `[]` a `[lineId]`, recibir `lineId` como prop.
4. `handleSaveDraft` (`page.tsx:104-122`): agregar `line_id` al payload de `.insert()`.

**Referencias:** Fase 0 — bloque "UI — Inbox/Broadcasts/Automations/Flows".

**Verificación:**
- Cuenta con 1 línea: el flujo de creación de broadcast es idéntico al actual (step invisible, línea default usada automáticamente).
- Cuenta con 2+ líneas: el step aparece, y las plantillas mostradas en el siguiente step corresponden solo a la línea elegida.

**Guardas anti-patrón:**
- No renumerar mal los `currentStep === N` al insertar el nuevo step — verificar los 4 steps existentes (`template`/`audience`/`personalize`/`send`) siguen funcionando en orden tras el cambio.

---

## Fase 9 — UI: Automations y Flows (selector opcional de línea)

**Qué implementar:**
1. **Antes de escribir código**: confirmar que las rutas API de automations/flows aceptan `line_id` en el body (gap identificado, no verificado aún).
2. Automations: `<select>` opcional dentro de `TriggerCard` (`automation-builder.tsx:826-840`, insertado después), siguiendo el patrón de `patchTop`. Payload de guardado (`:666-673`) incluye `line_id` (nullable).
3. Flows: celda adicional en el grid de `TriggerPanel` (`flow-builder.tsx:278-309`), agregado a `BuilderState` (`flow-editor-state.tsx:61-69`) y a los payloads de guardado (`:318-319`, `:341-342`).
4. Ambos: opción "Todas las líneas" (equivalente a `NULL`) como default y primera opción de la lista.

**Referencias:** Fase 0 — bloque "UI — Inbox/Broadcasts/Automations/Flows".

**Verificación:**
- Una automatización/flow sin línea seleccionada sigue disparando para mensajes de cualquier línea (comportamiento actual, sin regresión).
- Una automatización/flow con línea específica seleccionada NO dispara para mensajes de otras líneas.

**Guardas anti-patrón:**
- No hacer obligatoria la selección de línea — el default `NULL` ("todas") debe seguir siendo válido y ser el valor inicial.

---

## Fase 10 — Cierre: constraints finales, limpieza y regresión

**Qué implementar:**
1. Con todos los call sites migrados (Fases 2-9) y verificados en un entorno de staging/prueba con datos reales: `ALTER TABLE conversations/message_templates/broadcasts ALTER COLUMN line_id SET NOT NULL` (migración separada, `038_*.sql`).
2. `DROP TABLE whatsapp_config` (solo tras confirmar cero referencias activas — grep final).
3. Actualizar fixtures de tests: `src/app/api/whatsapp/send/route.test.ts`, `src/lib/whatsapp/resolve-conversation.test.ts`, y cualquier otro test que instancie `whatsapp_config` en sus mocks/fixtures.
4. Barrido final: `grep -rn "whatsapp_config" src/ supabase/` debe devolver cero resultados fuera de comentarios de changelog/migraciones históricas (las migraciones viejas no se editan retroactivamente).
5. Ejecutar la suite de tests completa + `tsc --noEmit` + build de producción.

**Verificación:**
- Suite de tests en verde.
- Build de Next.js compila sin errores en `src/`.
- Prueba manual de extremo a extremo: cuenta con 2 líneas de WABAs distintas, mensajes entrantes/salientes, un broadcast, una automatización y un flow, todos operando correctamente por línea, con un agente restringido a una sola línea confirmando que no ve la otra.

**Guardas anti-patrón:**
- No poner `NOT NULL` antes de verificar el backfill en un entorno con datos reales — si algún call site de las Fases 2-4 quedó sin actualizar, esta constraint lo revienta en el momento equivocado (producción) en vez de en desarrollo.
- No borrar `whatsapp_config` hasta que el grep final esté limpio — mantenerla como tabla huérfana unos días de más es más barato que un rollback de datos.
