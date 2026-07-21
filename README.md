# wacrm — CRM Template for WhatsApp

> Self-hostable CRM template for WhatsApp® — shared inbox, contacts,
> sales pipelines, broadcasts, and no-code automations. Fork it, brand
> it, host it.

<p align="center">
  <a href="https://www.hostinger.com/web-apps-hosting">
    <img src="./.github/assets/hostinger-deploy.png" alt="Ship your Node.js app in one click — Deploy to Hostinger" width="900">
  </a>
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](./LICENSE)
[![CI](https://github.com/ArnasDon/wacrm/actions/workflows/ci.yml/badge.svg)](https://github.com/ArnasDon/wacrm/actions/workflows/ci.yml)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e?logo=supabase)](https://supabase.com)
[![Stars](https://img.shields.io/github/stars/ArnasDon/wacrm?style=social)](https://github.com/ArnasDon/wacrm/stargazers)

The marketing site and self-host docs live in a separate repo:
[ArnasDon/wacrm-site](https://github.com/ArnasDon/wacrm-site)
([wacrm.tech](https://wacrm.tech)). This repo is the product —
clone or fork it to run your own CRM.

## What you get out of the box

- **Shared inbox** on the official WhatsApp Business API — multiple
  agents working one number, per-conversation assignment, status, and
  notes.
- **Contacts + tags + custom fields**, CSV import, deduplication.
- **Sales pipelines** (Kanban) with deals linked to conversations.
- **Broadcasts** with Meta-approved templates, delivery + read
  tracking, per-recipient variable substitution.
- **No-code automations** — triggers on inbound messages, new
  contacts, keywords, or schedule; conditional branches, waits,
  tags, webhooks. Visual builder.
- **AI reply assistant** — bring your own OpenAI, Anthropic, or Gemini key
  (stored encrypted; no per-seat AI fee, your data stays yours).
  One-click AI-drafted replies in the inbox, plus an optional
  auto-reply bot with a per-conversation cap and clean human handoff.
  Add a **knowledge base** (FAQs, policies, product docs) and it
  answers from your own content — hybrid retrieval (Postgres full-text,
  or semantic pgvector when an embeddings key is set).
- **Real-time dashboard** — response times, daily volume, pipeline
  value, cross-module activity feed.
- **Team accounts** — invite teammates by link, role-based access
  (owner / admin / agent / viewer), ownership transfer. Every install
  is account-scoped, so one shared inbox can be staffed by a whole
  team. Solo use stays single-user with zero setup.
- **Account management** — email, password, avatar, global sign-out.
- **Public REST API** (`/api/v1`) with scoped, revocable API keys —
  build your own automations on top of your CRM. See
  [docs/public-api.md](./docs/public-api.md).
- **MCP server** — drive your CRM from Claude, Cursor, and other AI
  assistants over the [Model Context Protocol](https://modelcontextprotocol.io).
  Read-only by default, opt-in writes. See [docs/mcp.md](./docs/mcp.md)
  (server in [`mcp-server/`](./mcp-server)).

## Why fork this?

This is a **template**, not a product. Forking means you get:

- **Full ownership** — your code, your Supabase project, your domain,
  your data. No SaaS lock-in, no seat pricing, no trust dance.
- **Full customisation** — add the fields your team needs, remove the
  modules you don't, redesign anything. The stack is boring on
  purpose (Next.js + Supabase + Tailwind) so the learning curve is
  short.
- **Zero ops to start** — [Hostinger](https://www.hostinger.com/web-apps-hosting)
  Managed Node.js deploys a fork in a few clicks. No Docker, no
  Kubernetes, no infra team needed.
  ([See below ↓](#-deploy-on-hostinger-recommended))
- **Real security primitives** — token encryption (AES-256-GCM), RLS
  on every table, HMAC-verified webhooks, CSP, rate limiting, CI
  typecheck/build on every PR.

Not a framework. Not an SDK. A concrete, working CRM you can stand up
in an afternoon and make yours.

## Quick start

```bash
# Fork on GitHub first: https://github.com/ArnasDon/wacrm → Fork
git clone https://github.com/<your-username>/wacrm.git
cd wacrm
npm install
cp .env.local.example .env.local   # fill in Supabase + Meta creds
npm run dev
```

Open <http://localhost:3000>. You'll be redirected to `/login` (or
`/dashboard` if already signed in).

## 🚀 Deploy on Hostinger (recommended)

<p align="center">
  <a href="https://www.hostinger.com/web-apps-hosting">
    <img src="./.github/assets/hostinger-deploy.png" alt="Ship your Node.js app in one click — Deploy to Hostinger" width="1000">
  </a>
</p>
<p align="center">
  <a href="https://wacrm.tech/docs/deployment-hostinger">
    <img src="https://img.shields.io/badge/Step--by--step_guide-wacrm.tech%2Fdocs-111?style=for-the-badge" alt="Step-by-step guide" height="44">
  </a>
</p>

**wacrm is built to run on [Hostinger](https://www.hostinger.com/web-apps-hosting).**
It's the path we test, document, and recommend — and the fastest way
to get a production-grade CRM live without owning a VPS or a
Kubernetes cluster.

### Why Hostinger?

| | |
|---|---|
| **One-click Git deploy** | Connect your fork, push to `main`, Hostinger builds and ships it. No SSH, no Docker, no CI to wire up — this repo's own `main` deploys this way. |
| **Managed Node.js** | Next.js 16 (App Router, server actions, ISR) runs out of the box on [Premium, Business, and Cloud](https://www.hostinger.com/web-apps-hosting) shared plans. You don't manage Node versions, processes, or reverse proxies. |
| **Free SSL + free domain** | Automatic Let's Encrypt on your custom domain (or a free one included with annual plans). HTTPS is on by default — required for the WhatsApp Business webhook. |
| **Global CDN + LiteSpeed** | Static assets cached at the edge, dynamic routes served from LiteSpeed. Snappy dashboards out of the box, no Cloudflare setup required. |
| **Env vars + logs in hPanel** | Set `SUPABASE_*`, `WHATSAPP_*`, and `ENCRYPTION_KEY` from the panel — no `.env` on the server. Live application logs in the same UI. |
| **DDoS protection + daily backups** | Built-in, no add-ons. The webhook endpoint is a public target — having protection at the edge matters. |
| **Cheaper than a VPS** | Plans start at a few dollars a month — order-of-magnitude less than a comparable managed Node.js host, and you don't pay extra for the database (that's Supabase). |
| **24/7 human support** | Live chat support in 20+ languages — useful when your CRM is the thing your team relies on to talk to customers. |

### The 60-second version

1. **Fork** this repo on GitHub.
2. In **hPanel → Websites → Create**, pick **Node.js** and connect
   your fork.
3. Paste your Supabase + Meta env vars into hPanel.
4. Push to `main`. Hostinger builds and serves it. Done.

Full walkthrough with screenshots:
**[wacrm.tech/docs/deployment-hostinger](https://wacrm.tech/docs/deployment-hostinger)**.

> _Note: wacrm is MIT-licensed and runs anywhere Node.js does
> (Vercel, Railway, your own VPS). Hostinger is recommended, not
> required._

## Documentation

Full self-host documentation — Supabase migrations, WhatsApp Business
API config, and production deploy — lives at
**[wacrm.tech/docs](https://wacrm.tech/docs)**
(source: [ArnasDon/wacrm-site](https://github.com/ArnasDon/wacrm-site)).

Key pages:
- [Getting started](https://wacrm.tech/docs/getting-started)
- [Supabase setup](https://wacrm.tech/docs/supabase-setup)
- [WhatsApp setup](https://wacrm.tech/docs/whatsapp-setup)
- [Environment variables](https://wacrm.tech/docs/environment-variables)
- [Deploy on Hostinger](https://wacrm.tech/docs/deployment-hostinger)
- [Architecture](https://wacrm.tech/docs/architecture)
- [Troubleshooting](https://wacrm.tech/docs/troubleshooting)

## Instagram (optional)

The shared inbox can also receive and reply to Instagram Direct
Messages, alongside WhatsApp — same inbox, same contacts/tags/notes
model, a channel icon on each conversation, and a combined channel
filter once you've connected more than one line/account.

Broadcasts are supported too, with Instagram's real constraints made
explicit rather than hidden: no approved-template mechanism like
WhatsApp, so a broadcast is a free-text message sent only to contacts
who wrote to you in the last 24 hours (Instagram's messaging window).
It's a separate, simpler flow (**Broadcasts → New Instagram
broadcast**) rather than a branch of the WhatsApp wizard, since
there's no template/personalization step to share.

This is phases 1-2 of a larger effort; **not yet supported for
Instagram**: automations, Flows, and the AI reply assistant.

To turn it on:

1. Create a Meta app with Instagram Messaging enabled, linked to a
   Facebook Page connected to the Instagram business account you want
   to use.
2. In **Settings → Instagram**, paste the Instagram Business Account
   ID, the linked Page ID, and a Page access token. Connection is
   manual entry, same as WhatsApp — no OAuth flow in this phase.
3. Point the app's webhook at `https://your-crm.example.com/api/instagram/webhook`.
   It reuses the same `META_APP_SECRET` as the WhatsApp webhook — no
   new environment variable needed.

## Platform admin panel (optional)

wacrm runs perfectly well self-hosted for a single team with no setup
beyond the Quick start above — this section only applies if you're
operating it as a multi-tenant SaaS for other people's accounts.

An internal super-admin panel lists every account on the instance and
lets your team suspend/reactivate accounts, request/cancel deletion,
and temporarily act as an account's owner for support (with a full
audit trail the account's own members can see, and a 30-minute
auto-expiring session with a persistent "Acting as…" banner).

To turn it on:
1. Set `PLATFORM_ADMIN_HOST` and `NEXT_PUBLIC_APP_HOST` (see
   `.env.local.example`) and point a DNS record at the admin host —
   no separate deployment needed.
2. Grant access by hand — there's no UI for this in v1:

   ```sql
   UPDATE profiles SET is_platform_admin = true WHERE user_id = '<uuid>';
   ```

3. Optionally schedule `GET /api/platform-admin/cron/purge-pending-deletions`
   (daily) with `PLATFORM_ADMIN_CRON_SECRET` set, to hard-delete
   accounts 30+ days past a requested deletion.

## Billing and plans (optional)

Builds on the platform admin panel above — skip this too if you
self-host for one team, or if you're running the admin panel without
charging for access.

Adds real recurring billing: fixed-tier plans (Pro/Business, seeded
in a migration — no plan-creation UI in v1), a 14-day trial, and
self-serve checkout via [MercadoPago](https://www.mercadopago.com)
(chosen because Stripe doesn't yet support Chile as a seller
country — see `docs/superpowers/specs/2026-07-18-billing-plans-design.md`
for the full reasoning). The payment provider sits behind a
`BillingProvider` interface (`src/lib/billing/providers/`), so
swapping providers later doesn't touch the rest of the system.

A cron keeps `accounts.status` (suspend/reactivate, shared with the
platform admin panel) in sync with payment state — an expired trial
or a failed payment auto-suspends an account after a grace period,
distinct from a manual suspension the super-admin panel can still do
independently.

To turn it on:

1. Set `MERCADOPAGO_ACCESS_TOKEN` and `MERCADOPAGO_WEBHOOK_SECRET`
   (see `.env.local.example`) from your MercadoPago developer panel.
2. Point MercadoPago's webhook configuration at
   `POST /api/billing/webhook`.
3. Schedule `GET /api/billing/cron/check-trials` (daily) with
   `BILLING_CRON_SECRET` set — a safety net if a webhook delivery is
   ever missed.
4. Update the seeded plan prices in `plans` (migration
   `041_billing_plans.sql` inserts placeholder `0` CLP prices) once
   you've decided real pricing.

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript, Tailwind v4.
- **Data** — Supabase (Postgres + Auth + Storage + RLS).
- **WhatsApp** — Meta Cloud API (official WhatsApp Business API).

## Contributing

This is a template, not a collaborative product — the expected flow is
fork → customise → deploy, **not** upstream contribution. Bug reports
and security issues are welcome; feature PRs often belong in your fork
rather than here. Details in
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and
[`.github/SECURITY.md`](./.github/SECURITY.md).

## License

[MIT](./LICENSE). Fork it, brand it, host it.
