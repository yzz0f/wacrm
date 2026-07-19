# Diseño: Instagram — Broadcasts (sub-proyecto 2 de 4)

**Alcance:** Segundo sub-proyecto del esfuerzo de Instagram. Depende de la Fundación (`docs/superpowers/specs/2026-07-19-instagram-foundation-design.md`, mergeada), no la modifica.

## Problema

Instagram no tiene templates aprobados por Meta como WhatsApp — la única forma de mandarle un mensaje a alguien es una respuesta libre dentro de la ventana de 24h desde su último mensaje entrante (o 7 días con el Human Agent tag, sin usar en esta fase). Un "broadcast" de Instagram es estructuralmente distinto: no hay forma de abrir conversación con alguien que no te escribió recientemente.

## Decisiones

- **Composición:** texto libre (no template), reusando el wizard de broadcasts existente con una rama nueva para el paso de contenido.
- **Audiencia:** el paso de selección de destinatarios pre-filtra por defecto a contactos de Instagram con un mensaje entrante en las últimas 24h (calculado una vez al abrir el paso, no en tiempo real).
- **Envío:** se intenta a todos los seleccionados igual — la pre-filtración reduce fallos pero no los garantiza (la ventana puede cerrar entre selección y envío). Los fallos por fuera de ventana se reportan por destinatario (`broadcast_recipients.status = 'failed'`), mismo patrón que ya usa WhatsApp para sus propios fallos de envío.

## Modelo de datos

Migración nueva (confirmar el próximo número libre contra `supabase/migrations/` real al implementar).

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

Mismo patrón de "pertenece a exactamente uno de N padres" que `conversations.line_id`/`instagram_account_id` en la Fundación. `broadcast_recipients` no cambia — su `status`/`error_message` ya modelan un fallo por destinatario sin ambigüedad.

## Envío

`src/lib/instagram/broadcast-instagram-core.ts` (paralelo a `src/lib/whatsapp/broadcast-core.ts`): `createInstagramBroadcast()` (valida, resuelve destinatarios, persiste `broadcasts` + `broadcast_recipients` en `pending`) y `deliverInstagramBroadcast()` (fan-out sobre `sendInstagramText`, sin el reintento de variantes de teléfono que usa WhatsApp — no aplica a un IGSID). Un fallo con `isOutsideMessagingWindowError` (ya existe en `meta-instagram-api.ts`) marca la fila como `failed` con un mensaje claro ("Fuera de la ventana de mensajería de 24h").

Ruta nueva `src/app/api/instagram/broadcast/route.ts`, paralela a `src/app/api/whatsapp/broadcast/route.ts`.

## Audiencia — pre-filtro de ventana de 24h

Helper `getInstagramReachableContacts(db, accountId, instagramAccountId)`: contactos de `platform = 'instagram'` con al menos un mensaje en `messages` con `sender_type = 'customer'` y `created_at` dentro de las últimas 24h. **No** se puede usar `conversations.last_message_at` para esto — esa columna se actualiza tanto en mensajes entrantes como salientes (ver `src/app/api/instagram/webhook/route.ts:394` y `src/lib/instagram/send-instagram-message.ts:148`), así que un agente respondiendo "extendería" la ventana incorrectamente. Se calcula una sola vez al abrir el paso de audiencia del wizard — no se re-verifica mientras el usuario arma el broadcast.

## UI

`src/components/broadcasts/` gana una rama por canal: si la línea/cuenta elegida es de Instagram, el paso "elegir template" (`step1-choose-template.tsx`) se reemplaza por un textarea de mensaje libre; el paso de audiencia reusa el mismo componente pero recibe la lista pre-filtrada de contactos alcanzables cuando el canal es Instagram; revisión y envío se reutilizan sin cambios (ya son agnósticos de cómo se compuso el contenido).

## Fuera de alcance

- Human Agent tag (extensión a 7 días) — v1 usa solo la ventana estándar de 24h.
- Adjuntar medios a un broadcast de Instagram — solo texto en esta fase (coherente con que WhatsApp broadcasts tampoco soporta medios ad-hoc fuera de templates).
- API pública (`/api/v1/broadcasts`) para Instagram — solo UI del dashboard en esta fase.
