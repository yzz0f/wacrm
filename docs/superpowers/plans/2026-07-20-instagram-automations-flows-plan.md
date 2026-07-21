# Plan — Instagram support: Automations + Flows (sub-proyecto 3 de 4)

Spec: `docs/superpowers/specs/2026-07-20-instagram-automations-flows-design.md`

Base: rama `feat/instagram-automations-flows`, creada desde
`feat/instagram-broadcasts` (PR #11 aún abierto sobre `main` en
`yzz0f/wacrm` al momento de escribir este plan — se rebasa/actualiza si
`main` avanza antes de abrir el PR de este sub-proyecto).

Confirmado en el spec (no repetir la investigación): `automations.line_id`
/ `flows.line_id` no se filtran en runtime hoy, así que no se agrega
`instagram_account_id` como columna de restricción — **este plan no toca
`supabase/migrations/`**.

## Fase 1 — Disparo de Flows/Automations desde el webhook de Instagram

Archivo: `src/app/api/instagram/webhook/route.ts`.

1. En `processInstagramMessage` (línea 334), después del insert de
   `messages` (línea 374-383) y antes/junto al update de `conversations`
   (línea 390-402), calcular `isFirstInboundMessage` con la misma
   consulta que `processMessage` de WhatsApp usa en
   `src/app/api/whatsapp/webhook/route.ts:673-678` — contar
   `messages` con `conversation_id = conversation.id AND sender_type = 'customer'`
   **antes** del insert de la línea 374 (mover el cálculo a ese punto,
   igual que WhatsApp lo hace antes de su propio insert).
2. Reemplazar el bloque de comentario "Deliberately no ... here" (línea
   404-406) por las mismas dos llamadas que
   `src/app/api/whatsapp/webhook/route.ts:740-807` hace, adaptadas:
   - `dispatchInboundToFlows({ accountId, userId: accountOwnerUserId, contactId: contactRecord.id, conversationId: conversation.id, message: { kind: 'text', text: contentText ?? '', meta_message_id: message.mid }, isFirstInboundMessage })`
     — Instagram no produce `interactive_reply` entrante en este
     alcance (Fundación no implementó botones/listas de Instagram), así
     que siempre es `kind: 'text'`.
   - Igual que WhatsApp, usar `flowResult.consumed` para suprimir
     `new_message_received`/`keyword_match` cuando el flow consumió el
     mensaje, y disparar `runAutomationsForTrigger` para cada trigger
     que aplique (`new_contact_created` si `contactOutcome.wasCreated`,
     `first_inbound_message` si `isFirstInboundMessage`,
     `new_message_received`/`keyword_match` si no fue consumido por un
     flow). Sin `interactive_reply` (no aplica aquí).
   - Mismos imports que ya usa `whatsapp/webhook/route.ts:8-9`:
     `import { runAutomationsForTrigger } from '@/lib/automations/engine'`
     y `import { dispatchInboundToFlows } from '@/lib/flows/engine'`.
   - Fire-and-forget para `runAutomationsForTrigger` (`.catch(...)`),
     `await` para `dispatchInboundToFlows` — mismo patrón que WhatsApp.

**Verificación**: `pnpm typecheck`; test manual no aplicable (sin sandbox
de Meta) — cubierto por el unit test de Fase 5.

## Fase 2 — Ruteo de canal en `src/lib/automations/meta-send.ts`

1. En `sendViaMeta` (línea 108), después de obtener `contact` (línea
   119-127), leer también `platform, external_id` del contacto (agregar
   al `.select('id, phone')` → `.select('id, phone, platform, external_id')`).
2. Reemplazar el bloque de resolución de línea (línea 134-154) por: leer
   `conversations.line_id, instagram_account_id` de una sola vez. Si
   `instagram_account_id` está seteado:
   - Si `input.kind === 'template'`, lanzar
     `new Error('Instagram conversations do not support templates yet')`
     inmediatamente (antes de tocar `contact.phone`, que será `null` para
     un contacto de Instagram — evita que el check de la línea 125 lo
     rechace con un mensaje confuso).
   - Si `input.kind === 'text'`, resolver `instagram_accounts` por
     `instagram_account_id` (`.select('id, access_token').eq('id', ...).eq('account_id', input.accountId).maybeSingle()`),
     desencriptar el token con `decrypt()` (ya importado, línea 7), y
     llamar `sendInstagramText({ pageAccessToken, recipientId: contact.external_id, text: input.text })`
     (`src/lib/instagram/meta-instagram-api.ts`, ya usado en
     `src/lib/instagram/broadcast-instagram-core.ts:159-163` como
     referencia exacta de la firma). Sin `phoneVariants`/reintento (no
     aplica a un IGSID).
   - Insertar el `messages` row y actualizar `conversations` igual que el
     bloque existente (línea 211-234), reusando `waMessageId` de la
     respuesta de `sendInstagramText`.
   - Si `line_id` está seteado (o ninguno de los dos, caso legacy),
     mismo camino WhatsApp que ya existe hoy sin cambios.
3. El check de `contact.phone` (línea 125) debe moverse a **después** de
   determinar el canal — solo aplica cuando el canal es WhatsApp. Para
   Instagram, el check equivalente es `contact.external_id` truthy.
4. `engineSendTemplate` no cambia de firma; el error de "no soportado"
   sale de `sendViaMeta` como se describe en el punto 2.
5. `engineSendInteractive` (línea 80-102) delega en
   `engineSendInteractiveButtons`/`engineSendInteractiveList` de
   `flows/meta-send.ts` — no necesita cambios propios; el guard de
   Instagram vive en esas dos funciones (Fase 3).

**Verificación**: `pnpm typecheck`, `pnpm lint` sobre el archivo.

## Fase 3 — Ruteo de canal en `src/lib/flows/meta-send.ts`

1. Nueva función interna `resolveChannelForConversation(db, accountId, conversationId)`
   que reemplaza `resolveLineForConversation` (línea 28-48): devuelve
   `{ channel: 'whatsapp', config } | { channel: 'instagram', account }`
   leyendo `conversations.line_id, instagram_account_id`. Si
   `instagram_account_id` está seteado, resuelve la fila de
   `instagram_accounts` (mismo patrón que Fase 2); si no, el camino
   `whatsapp_lines` existente sin cambios de comportamiento.
2. **`engineSendText`** (línea 96-182): tras resolver contacto, ramifica
   por canal antes del check de `contact.phone`. Rama Instagram: usa
   `contact.external_id`, llama `sendInstagramText`, sin
   `phoneVariants`, mismo insert de `messages` (`sender_type: 'bot'`,
   `content_type: 'text'`, respeta `args.aiGenerated`) y mismo update de
   `conversations`.
3. **`engineSendMedia`** (línea 206-299): mismo patrón. Rama Instagram
   llama `sendInstagramMedia` (`src/lib/instagram/meta-instagram-api.ts`
   — confirmar firma exacta leyendo el archivo al implementar esta fase,
   ya que solo `sendInstagramText` fue citado literalmente en la
   Fundación; no asumir el shape de `sendInstagramMedia` de memoria).
   `content_type` sigue siendo `args.kind` (`image`/`video`/`document`),
   igual que hoy.
4. **`sendInteractiveViaMeta`** (línea 355-493, usada por
   `engineSendInteractiveButtons`/`engineSendInteractiveList`): al
   resolver el canal, si es Instagram, lanzar
   `new Error('Instagram conversations do not support buttons/lists yet')`
   antes de tocar `contact.phone`.
5. Actualizar el comentario de cabecera de `resolveLineForConversation`
   (línea 21-27) para reflejar el nuevo nombre/alcance.

**Verificación**: `pnpm typecheck`, `pnpm lint` sobre el archivo.

## Fase 4 — Aviso informativo en los builders

1. `src/components/automations/automation-builder.tsx`: en el render de
   configuración de paso (switch en línea ~1544, casos `send_buttons`
   `send_list` `send_template` — línea 1548-1550) y en el `AddButton`/lista
   de tipos añadibles si tiene descripciones inline, agregar una línea de
   texto de ayuda (`<p className="text-xs text-muted-foreground">`)
   junto al formulario de esos tres tipos: *"Solo se envía en
   conversaciones de WhatsApp — en Instagram este paso fallará."*
   No se agrega lógica condicional, ningún estado nuevo, ninguna
   validación — puramente texto estático en el JSX existente de cada
   caso.
2. `src/components/flows/forms/node-config-form.tsx`: mismo aviso en los
   casos `send_buttons` (línea 98), `send_list` (línea 110) — `send_media`
   y `send_message` NO llevan aviso (soportados en Instagram desde la
   Fase 3).
3. Sin cambios en `src/components/flows/shared.tsx` (`NODE_META`) — los
   iconos/colores no necesitan tocarse, solo el formulario de
   configuración.

**Verificación**: `pnpm typecheck`; revisión visual rápida en
`pnpm dev` abriendo el builder de un automation y de un flow, agregando
un paso `send_buttons`/`send_list`/`send_template` y confirmando que el
aviso aparece.

## Fase 5 — Tests, README, cierre

1. `src/lib/automations/meta-send.test.ts` (crear si no existe — revisar
   primero si ya hay un test file para este módulo) — casos: envío de
   texto por Instagram exitoso (mock `sendInstagramText`), error
   explícito al intentar `send_template` en una conversación de
   Instagram.
2. `src/lib/flows/meta-send.test.ts` (ídem) — casos: `engineSendText` y
   `engineSendMedia` exitosos por Instagram, error explícito para
   `engineSendInteractiveButtons`/`List` en conversación de Instagram.
3. Test para el webhook de Instagram (`src/app/api/instagram/webhook/route.test.ts`
   si existe, si no crear uno acotado): verificar que
   `dispatchInboundToFlows` y `runAutomationsForTrigger` se invocan tras
   un mensaje entrante, con mocks de ambos módulos (no se prueba la
   lógica interna de los motores aquí, solo que el webhook los llama con
   los argumentos correctos — mismo alcance que cualquier test de
   integración superficial ya existente en el repo para este webhook).
4. `README.md`: mover Automations/Flows de la lista "not yet supported"
   de Instagram a la sección de soporte, con la misma nota de límite ya
   usada para Broadcasts (solo texto/media, sin templates/botones/listas).
5. Commit por fase (mismo estilo que sub-proyecto 2), push, abrir PR
   contra `main` (o contra `feat/instagram-broadcasts` si su PR #11
   sigue sin mergear al momento de abrir este — verificar con
   `git merge-base --is-ancestor` antes de decidir la base, evitando el
   gotcha de PRs apilados ya documentado en la sesión).

**Verificación de cierre**: `pnpm typecheck && pnpm lint && pnpm test`
en verde antes de abrir el PR.
