# Plan — Instagram AI auto-reply (sub-proyecto 4 de 4)

Spec: `docs/superpowers/specs/2026-07-20-instagram-ai-autoreply-design.md`

Base: rama `feat/instagram-ai-autoreply`, creada desde
`feat/instagram-automations-flows` (PR #12 abierto contra
`feat/instagram-broadcasts`, PR #11 — ambos aún sin mergear a `main` al
momento de escribir este plan; se reevalúa la base del PR antes de
abrirlo, igual que en el sub-proyecto 3).

## Fase 1 — Disparo desde el webhook de Instagram

Archivo: `src/app/api/instagram/webhook/route.ts`.

1. Import: `import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'`
   (mismo import que `src/app/api/whatsapp/webhook/route.ts:10`).
2. Justo después del bloque de `runAutomationsForTrigger` agregado en el
   sub-proyecto 3 (Fase 1 de ese plan), agregar:
   ```ts
   if (!flowConsumed && contentText?.trim()) {
     await dispatchInboundToAiReply({
       accountId,
       conversationId: conversation.id,
       contactId: contactRecord.id,
       configOwnerUserId: accountOwnerUserId,
     })
   }
   ```
   Mismo patrón que `src/app/api/whatsapp/webhook/route.ts:815-822`,
   sin el chequeo `!interactiveReplyId` (no aplica — ver spec).

**Verificación**: `pnpm typecheck`, `pnpm lint` sobre el archivo.

## Fase 2 — Test + README + cierre

1. Test dirigido en el mismo espíritu que las verificaciones ya
   agregadas para Fase 1 del sub-proyecto 3 (si existe un test file para
   el webhook de Instagram; si no, se deja sin test de ruta igual que el
   resto del webhook — ver la nota de la Fase 5 del sub-proyecto 3 sobre
   por qué no hay tests de ruta para ninguno de los dos webhooks hoy).
2. `README.md`: mover "the AI reply assistant" de la lista "not yet
   supported" de Instagram a la sección de soporte (línea ~171).
3. `pnpm typecheck && pnpm lint && pnpm test` en verde.
4. Commit, push, abrir PR (verificar con `git merge-base --is-ancestor`
   contra qué rama abrir, igual que en el sub-proyecto 3).
