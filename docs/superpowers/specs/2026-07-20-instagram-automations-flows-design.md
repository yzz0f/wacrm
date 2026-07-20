# Instagram support — Automations + Flows (sub-proyecto 3 de 4)

## Contexto

La Fundación de Instagram (sub-proyecto 1) dejó `processInstagramMessage`
(`src/app/api/instagram/webhook/route.ts`) deliberadamente sin disparo de
Flows ni Automations — el comentario en la línea 404 lo marca como alcance
futuro. Este sub-proyecto cierra ese hueco: los mensajes entrantes de
Instagram deben poder disparar Flows y Automations igual que los de
WhatsApp, y las acciones de envío de texto/media de ambos motores deben
poder responder por Instagram cuando la conversación es de ese canal.

## Hallazgo clave: `line_id` no se filtra en tiempo de ejecución

`automations.line_id` y `flows.line_id` (migración 037) son columnas
nullable sin CHECK, pensadas como "restricción opcional a una línea". En
la práctica, **ningún motor las consulta**:

- `runAutomationsForTrigger` (`src/lib/automations/engine.ts:64-116`) trae
  todas las automations activas de la cuenta que coincidan en
  `trigger_type`, y filtra solo con `triggerMatches()` (keywords / reply
  id) — nunca compara `automation.line_id` contra la conversación.
- `dispatchInboundToFlows` → `findEntryFlow` (`src/lib/flows/engine.ts:829-874`)
  recibe `accountId`, el mensaje y `isFirstInboundMessage`; no recibe ni
  usa `line_id`/`conversation_id` para decidir qué flow arrancar.

Es decir, `line_id` se puede guardar desde la API pero es vestigial en
runtime. Por lo tanto este sub-proyecto **no** agrega `instagram_account_id`
como columna de restricción — sería una columna con el mismo problema
(guardable pero sin efecto). Si en el futuro se implementa el filtro real
por línea, ahí se agrega la contraparte de Instagram junto con eso. Fuera
de alcance aquí.

## Alcance

### 1. Disparo desde el webhook de Instagram

`processInstagramMessage` gana los mismos dos hooks que ya tiene
`processMessage` de WhatsApp (`src/app/api/whatsapp/webhook/route.ts:740-820`):

- `dispatchInboundToFlows(...)` — mismo shape de `message` (`text` o
  `interactive_reply`; Instagram por ahora solo puede producir `text`,
  ver Fundación), mismas reglas de supresión de triggers de automations
  cuando el flow consume el mensaje.
- `runAutomationsForTrigger(...)` por cada trigger que aplique
  (`new_contact_created`, `first_inbound_message`, `new_message_received`,
  `keyword_match`) — Instagram no tiene mensajes interactivos entrantes
  todavía, así que `interactive_reply` no se dispara desde este webhook.

Ambos motores ya son agnósticos de canal a este nivel (trabajan sobre
`contactId`/`conversationId`/`accountId`), así que no se toca
`engine.ts` de ninguno de los dos para esta parte.

### 2. Envío desde los motores — bifurcación de canal en `meta-send.ts`

Cada función de envío en `src/lib/automations/meta-send.ts` y
`src/lib/flows/meta-send.ts` ya resuelve el canal leyendo
`conversations.line_id` vía `resolveLineForConversation()` /  el bloque
equivalente en `sendViaMeta()`. Se cambia esa resolución para que lea
también `conversations.instagram_account_id` y bifurque:

- **`engineSendText`** (ambos motores) y **`engineSendMedia`** (Flows):
  si `conversation.instagram_account_id` está seteado, envían por
  `sendInstagramText` / `sendInstagramMedia`
  (`src/lib/instagram/meta-instagram-api.ts`, ya existentes desde la
  Fundación) usando `contact.external_id` como destinatario en vez de
  `contact.phone`, y el token de `instagram_accounts` (desencriptado con
  la misma `decrypt()` de `@/lib/whatsapp/encryption`) en vez del de
  `whatsapp_lines`. Sin reintento de variantes de teléfono (no aplica a
  un IGSID). El insert en `messages` y el update de
  `conversations.last_message_*` quedan igual que hoy.
- **`engineSendTemplate`** (Automations) y
  **`engineSendInteractiveButtons` / `engineSendInteractiveList`**
  (Flows, y `engineSendInteractive` en Automations que delega en ellas):
  si la conversación es de Instagram, lanzan
  `new Error('Instagram conversations do not support templates/buttons/lists yet')`
  antes de intentar nada contra Meta. El motor ya envuelve cada paso en
  try/catch y registra el fallo en `automation_logs` / el estado del
  `flow_run` — mismo comportamiento que cualquier otro error de envío
  hoy (ninguna acción sobre `engine.ts`).

No se introduce un tipo de paso nuevo ("send Instagram message"): un
`send_message`/`send_media` en Automations o Flows simplemente responde
por el canal de la conversación que lo disparó, igual que ya hace con
WhatsApp — coherente con que la Fundación tampoco separó los tipos de
paso por canal.

### 3. Aviso en el builder (no bloqueo)

Como `line_id`/`instagram_account_id` no restringen qué automation o
flow corre en qué conversación, no hay forma de saber en tiempo de
edición si un `send_template`/`send_buttons`/`send_list` va a fallar en
producción. En vez de ocultar esas opciones (falsa sensación de
control), se agrega un texto de ayuda corto junto al selector de tipo de
paso en el builder de Automations y de Flows: *"Templates, botones y
listas solo se envían en conversaciones de WhatsApp — en Instagram el
paso fallará."* Puramente informativo, sin lógica de validación nueva.

## Fuera de alcance

- Filtro real de `line_id`/canal en el despacho de triggers (gap
  preexistente, no introducido por este sub-proyecto).
- Cualquier acción de Instagram más allá de texto y media (no hay
  templates/botones/listas de Instagram — mismo límite que Broadcasts y
  Fundación).
- AI auto-reply para Instagram (sub-proyecto 4).

## Testing

- Unit tests nuevos para la bifurcación de canal en
  `src/lib/automations/meta-send.ts` y `src/lib/flows/meta-send.ts`
  (envío por Instagram exitoso, error explícito para
  template/buttons/list en conversación de Instagram).
- Unit test para el webhook de Instagram: verificar que
  `dispatchInboundToFlows` y `runAutomationsForTrigger` se llaman con
  los mismos argumentos que en el flujo de WhatsApp equivalente.
