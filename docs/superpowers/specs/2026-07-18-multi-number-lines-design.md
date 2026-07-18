# Multi-número por cuenta (WhatsApp "Lines")

**Estado:** Aprobado para plan de implementación
**Fecha:** 2026-07-18
**Alcance:** Sub-proyecto 1 de 2. El panel de super-admin de plataforma (para operar el SaaS multi-cliente) es un sub-proyecto separado, con su propio spec, que se diseñará después.

## Motivación

wacrm se está preparando para operarse como SaaS multi-cliente desde un solo despliegue. Dentro de eso, cada cliente (cuenta) necesita poder conectar más de un número de WhatsApp — por ejemplo una línea de Ventas y otra de Soporte, o números por sucursal — todos administrados desde el mismo panel, con permisos independientes por línea.

Facturación/planes por cliente queda explícitamente fuera de alcance de este documento.

## Estado actual (por qué esto no es trivial)

- `whatsapp_config` tiene `UNIQUE(account_id)` **y** `UNIQUE(phone_number_id)` — una cuenta solo puede tener una fila, es decir, un número.
- El webhook entrante resuelve la cuenta destino buscando por `phone_number_id` y asume una sola fila coincidente.
- `conversations`, `messages`, `broadcasts`, `message_templates` y `automations`/`flows` solo llevan `account_id`, nunca "a qué número pertenece esto" — porque hasta hoy no hace falta.
- Cada punto de envío (`send-message.ts`, `broadcast-core.ts`, `meta-send.ts` de automations y de flows, `template-send-builder.ts`) resuelve credenciales haciendo "trae la única fila de `whatsapp_config` de esta cuenta".
- Los números de una misma cuenta pueden venir de **WABAs completamente distintas** (confirmado con el usuario) — no se puede asumir que comparten plantillas ni credenciales.

## Decisiones de producto (confirmadas en brainstorming)

1. **Identidad de contacto**: un contacto es único a nivel de cuenta (comparte notas, tags, deals, historial), no por línea. Si el mismo número le escribe a dos líneas distintas de la misma empresa, es el mismo contacto con dos conversaciones separadas. *(Aislar contactos por línea queda anotado como posible ajuste de configuración futuro — no se construye en este sub-proyecto, por YAGNI: el modelo de datos no lo bloquea, pero no hay toggle de UI todavía.)*
2. **Acceso por línea**: se puede restringir qué agentes/viewers ven qué líneas.
   - Owners/admins ven **todas** las líneas siempre, sin excepción — no participan del sistema de restricción.
   - Un agente/viewer **sin ninguna fila de acceso** para una línea dada **no la ve** — el modelo es deny-by-default por línea, no allow-by-default.
   - **Excepción de migración**: el día que una cuenta existente se migra, se le da acceso automático a todos sus miembros actuales sobre la línea migrada, para que nadie pierda acceso a lo que ya veía. La regla estricta ("sin asignar = sin acceso") solo aplica a líneas **nuevas** que se agreguen después.
3. **Automations/flows**: aplican a todas las líneas por defecto; opcionalmente se pueden restringir a una línea específica.
4. **Broadcasts**: siempre se envían desde una línea específica, elegida al crear la difusión (porque cada línea tiene sus propias plantillas/credenciales).
5. **Conversaciones nuevas iniciadas manualmente** (ej. botón "Mensaje" desde la ficha de un contacto, cuando no existe conversación previa): usan la línea `is_default` de la cuenta automáticamente; si la cuenta tiene más de una línea, se puede elegir otra desde el mismo flujo antes de enviar.
6. **UI**: se reutilizan los componentes existentes (`Card`, `Button`, badges de estado, patrón de filtros tipo pastilla) — no se introducen patrones visuales nuevos. Si una cuenta solo tiene una línea, toda la UI relacionada con líneas (filtro en inbox, etiquetas, selector en broadcasts) queda oculta — no se le muestra complejidad a quien no la necesita.

## Modelo de datos

### `whatsapp_lines` (reemplaza `whatsapp_config`)

Mismas columnas que `whatsapp_config` hoy (`phone_number_id`, `waba_id`, `access_token` cifrado, `verify_token`, `status`, `registered_at`, `subscribed_apps_at`, `last_registration_error`), más:

- `name` (text) — etiqueta visible, ej. "Ventas"
- `is_default` (boolean) — exactamente una línea por cuenta debe tener `true` (índice único parcial `WHERE is_default`)
- Constraints: `UNIQUE(phone_number_id)` global (igual que hoy — un número pertenece a una sola línea, para siempre). Índice en `account_id`. Se elimina el `UNIQUE(account_id)` actual.

### `conversations`

- `+ line_id` (FK `whatsapp_lines`, `NOT NULL` tras el backfill de migración)

### `messages`

- Sin cambios de esquema. Hereda la línea a través de `conversation.line_id` — una sola fuente de verdad, evita que quede desincronizado.

### `message_templates`

- `+ line_id` (FK `whatsapp_lines`, `NOT NULL`) — las plantillas se aprueban por WABA, así que quedan ancladas a la línea, no a la cuenta.

### `broadcasts`

- `+ line_id` (FK `whatsapp_lines`, `NOT NULL`) — se elige al crear la difusión.

### `automations` / `flows`

- `+ line_id` (FK `whatsapp_lines`, **nullable**) — `NULL` = aplica a todas las líneas de la cuenta (comportamiento por defecto, igual que hoy).

### `line_access` (nueva tabla)

- `line_id` (FK `whatsapp_lines`), `profile_id` (FK `profiles`), `PRIMARY KEY(line_id, profile_id)`.
- Solo es relevante para roles `agent`/`viewer`. `owner`/`admin` no la consultan — bypass total.
- Semántica: si un `agent`/`viewer` no tiene ninguna fila para una línea dada, no la ve. Punto.

## Row Level Security

- `whatsapp_lines`: mismas policies que `whatsapp_config` hoy (`is_account_member(account_id, 'admin')` para todo). Sin cambios de comportamiento.
- `conversations` / `messages` (vía join a su conversation) y cualquier tabla que hoy solo chequea `is_account_member(account_id, tier)`:
  - Si `is_account_member(account_id, 'admin')` → acceso total (sin cambios).
  - Si el rol es exactamente `agent` o `viewer` → además debe existir una fila en `line_access` para `(conversation.line_id, profile_id)`.
- Esto se implementa como una extensión del helper existente, no un mecanismo paralelo — mantiene el patrón repo-wide ya establecido (`017_account_sharing.sql` y migraciones posteriores que lo reutilizan).

## Webhook (bajo riesgo)

El webhook entrante sigue resolviendo por `phone_number_id` — que sigue siendo único globalmente — solo que ahora la fila vive en `whatsapp_lines`. La lógica central (`processMessage(message, contact, config.account_id, ...)`) gana `config.id` (el `line_id`) como parámetro adicional para setear `conversations.line_id` al crear/actualizar la conversación. Si el `phone_number_id` no matchea ninguna línea (borrada o mal configurada), el webhook responde `200` sin procesar — evita que Meta reintente indefinidamente un evento que nunca va a resolver.

## Puntos de envío a actualizar

Todos estos hoy resuelven credenciales por `account_id` (asumiendo una sola fila) y deben resolver por `line_id` en su lugar:

- `src/lib/whatsapp/send-message.ts` — recibe `line_id` de la conversación en curso.
- `src/lib/whatsapp/broadcast-core.ts` — recibe `line_id` de `broadcasts.line_id`.
- `src/lib/automations/meta-send.ts` — responde en la línea de la conversación que disparó la automatización.
- `src/lib/flows/meta-send.ts` — misma lógica, responde en la línea de la conversación del flow run.
- `src/lib/whatsapp/template-send-builder.ts` — arma la plantilla usando `message_templates.line_id` para saber de qué línea sacar las credenciales.
- `src/app/api/whatsapp/broadcast/route.ts`, `src/app/api/whatsapp/react/route.ts` — pasan `line_id` en vez de resolver la única config de la cuenta.

## UI

- **Configuración → Líneas** reemplaza el panel único "WhatsApp connection": lista de líneas (nombre, número, estado, badge "predeterminada"), botón "Agregar línea", cada fila abre el mismo formulario de credenciales que existe hoy (`whatsapp-config.tsx`), reutilizado por línea en vez de por cuenta.
- **Miembros del equipo** gana una sección "Acceso por línea" para asignar `agent`/`viewer` a líneas específicas (tabla `line_access`).
- **Bandeja de entrada**: fila de filtro adicional por línea (mismo componente de pastillas que ya existe para Todas/No leídas/Abiertas) + etiqueta chica de línea en cada conversación. **Oculto por completo si la cuenta tiene una sola línea.**
- **Difusiones**: selector de línea obligatorio en el wizard de creación (afecta qué plantillas aparecen disponibles, ya que las plantillas están ancladas a `line_id`).
- **Automations/Flows**: selector opcional de línea en el editor (default: todas).

## Migración

1. Crear tabla `whatsapp_lines` (mismo esquema que `whatsapp_config` + `name` + `is_default`).
2. Copiar cada fila de `whatsapp_config` a `whatsapp_lines` con `name = 'Línea principal'` (o el nombre de la cuenta) e `is_default = true`.
3. Agregar `line_id` (nullable primero) a `conversations`, `message_templates`, `broadcasts`; backfill con la única línea de la cuenta correspondiente; luego `NOT NULL`.
4. Agregar `line_id` (nullable) a `automations`/`flows` — queda `NULL` (todas las líneas), sin backfill necesario.
5. Crear una fila en `line_access` por cada miembro actual (`agent`/`viewer`) × la línea migrada de su cuenta — para que nadie pierda acceso el día del cambio.
6. Actualizar el webhook y todos los puntos de envío listados arriba.
7. Actualizar RLS policies de `conversations`/`messages` con la cláusula de `line_access`.
8. Reemplazar la UI de Configuración y agregar la sección de acceso por línea en Miembros.
9. Eliminar `whatsapp_config` una vez verificada la migración (no quedan consumidores fuera de los listados arriba, confirmado por grep previo).

## Manejo de errores

- **Reclamar un `phone_number_id` ya usado** por otra línea (de cualquier cuenta): mismo error de conflicto que existe hoy en `POST /api/whatsapp/config`.
- **Eliminar una línea con conversaciones activas**: bloqueado, mismo patrón UX que ya existe para "no se puede eliminar una etapa de pipeline con negocios activos" (`Pipelines.settings.toastMoveOrDeleteDeals`) — hay que mover/cerrar las conversaciones o archivar la línea (`status = 'disconnected'`) en vez de borrarla.
- **Webhook con `phone_number_id` sin línea coincidente**: responde `200` sin procesar (evita reintentos de Meta), se registra en logs para diagnóstico.

## Pruebas

- Script de migración corrido contra una copia de datos reales de una cuenta existente — verificar que `line_id` quede backfilled correctamente en las 3 tablas y que `line_access` quede poblado para todos los miembros.
- RLS: agente con fila en `line_access` para Línea A no puede leer conversaciones de Línea B de la misma cuenta; agente sin ninguna fila no ve ninguna línea (deny-by-default); owner/admin ven ambas sin necesitar filas.
- Cada punto de envío (broadcast, automation, flow, template) usa las credenciales de la línea correcta cuando la cuenta tiene 2+ líneas con WABAs distintas.
- Webhook: dos líneas bajo la misma cuenta, mensajes entrantes de cada número aterrizan en conversaciones con el `line_id` correcto.
- UI: cuenta con 1 sola línea no muestra ningún elemento relacionado a líneas (filtro de inbox, etiquetas, selector en broadcasts).
