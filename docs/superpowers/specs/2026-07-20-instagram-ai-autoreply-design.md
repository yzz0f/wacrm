# Instagram support — AI auto-reply (sub-proyecto 4 de 4)

## Contexto

`dispatchInboundToAiReply` (`src/lib/ai/auto-reply.ts`) ya es agnóstico
de canal: todos sus gates de elegibilidad y sus lecturas
(`loadAiConfig`, `buildConversationContext`, `retrieveKnowledge`,
`claim_ai_reply_slot`) operan sobre `conversation_id`/`account_id`, sin
tocar `whatsapp_lines` en ningún punto. Su único paso de envío es
`engineSendText` (`src/lib/flows/meta-send.ts:96`), que el sub-proyecto
3 (Automations + Flows) ya extendió para enrutar por Instagram cuando
`conversations.instagram_account_id` está seteado.

Es decir: el lado de generación + envío de la auto-respuesta de IA **ya
funciona para Instagram** sin cambios adicionales. Lo único que falta es
disparar la función desde el webhook de Instagram.

## Alcance

Agregar la llamada a `dispatchInboundToAiReply` en
`processInstagramMessage` (`src/app/api/instagram/webhook/route.ts`),
inmediatamente después del bloque de disparo de Automations agregado en
el sub-proyecto 3, con la misma condición que usa
`src/app/api/whatsapp/webhook/route.ts:815`: solo si el Flow no consumió
el mensaje (`!flowConsumed`) y hay texto no vacío. Instagram no produce
mensajes interactivos entrantes en este alcance, así que no hay
`interactiveReplyId` que excluir — la condición de WhatsApp
(`!interactiveReplyId`) se omite sin más.

## Fuera de alcance

- Cualquier cambio a `src/lib/ai/auto-reply.ts` o `src/lib/flows/meta-send.ts`
  — ya soportan Instagram de punta a punta.
- Base de conocimiento / prompts específicos de Instagram — el sistema
  ya es agnóstico de canal.

## Testing

- Extender el mismo estilo de test que ya cubre el webhook de WhatsApp
  para esta llamada (si existe); si no, un test dirigido en
  `src/lib/ai/auto-reply.test.ts` no es necesario (la función no cambia)
  — la cobertura nueva se limita a confirmar que el webhook de Instagram
  invoca `dispatchInboundToAiReply` con los argumentos correctos bajo la
  condición correcta.
