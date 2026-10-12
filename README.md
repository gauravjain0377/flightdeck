# Flightdeck — built for Recall.ai

Flightdeck is a developer console for understanding meeting-bot failures and webhook delivery problems. It supports a no-setup simulated demo and a live Recall.ai integration.

## Run the simulated demo

Requirements: Node 18 or newer.

```powershell
node server.js
```

Open http://localhost:3000. This mode seeds example bots and lets you switch the receiver between Healthy, Flaky, and Down.

## Run live mode

1. Copy `.env.example` to `.env`.
2. Create an API key in the [Recall API keys dashboard](https://us-east-1.recall.ai/dashboard/developers/api-keys).
3. Put the key in `.env` as `RECALL_API_KEY`.
4. Set `RECALL_REGION` to the region associated with that key.
5. Create a Google Meet test meeting at [meet.new](https://meet.new).
6. Start a tunnel to this server, for example `ngrok http 3000`.
7. In the Recall webhooks dashboard, configure:
   `https://YOUR-TUNNEL-DOMAIN/hooks/recall`
8. Copy the Recall workspace verification secret into `RECALL_WEBHOOK_SECRET`.
9. Start the server:

```powershell
node server.js
```

```text
Flightdeck → POST /api/v1/bot/
Recall → POST /hooks/recall
Flightdeck → verify Svix signature → persist event → push SSE update
Recall bot.done → retrieve transcript media → show transcript
```

Recall recommends scheduled bots with `join_at` for production. Flightdeck intentionally sends an ad-hoc bot from the demo form so it can be tested immediately.

## Environment variables

| Variable | Required | Purpose |
|---|---:|---|
| `RECALL_API_KEY` | Live only | Server-side Recall API token |
| `RECALL_REGION` | Live only | `us-east-1`, `us-west-2`, `eu-central-1`, or `ap-northeast-1` |
| `RECALL_WEBHOOK_SECRET` | Live webhooks | Svix/Recall workspace verification secret |
| `PORT` | No | Local HTTP port, default `3000` |
| `FLIGHTDECK_DATA_DIR` | No | Persistent JSON state directory |

`.env` and `data/` are ignored by Git. Do not commit API keys.

## Important endpoints

- `POST /api/bots` — create a simulated or real bot
- `GET /api/bots/:id` — inspect the lifecycle, diagnosis, and transcript
- `POST /hooks/recall` — verified Recall status webhook receiver
- `GET /api/deliveries` — delivery and verification history
- `GET /api/health` — mode and configuration health

## Known limits

- The live integration is intentionally focused on bots launched by Flightdeck.
- In live mode, status changes are webhook-driven; the API is not polled for lifecycle updates.
- Transcript media is loaded after `bot.done` when Recall exposes a download URL.
- Demo overlap markers are simulated; live transcript overlap is not inferred.
- The local JSON store is suitable for a demo, not multi-instance production deployment.
