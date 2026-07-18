# GitHub webhook transport and live receipt

Date: 2026-07-18

Ticket: #174

## Production route

The Planner GitHub App sends JSON webhooks to:

```text
https://ambient-agent.co-worker.tech/channels/github/webhook
```

`ambient-agent.co-worker.tech` is an explicit proxied Cloudflare DNS record. It
does not reuse the `co-worker.tech`, `app`, `api`, or `docs` Railway records. The
Cloudflare origin is the `code-factory` rig, where Caddy terminates TLS and
proxies only this hostname to Ambient Agent on `127.0.0.1:42069`:

```caddyfile
ambient-agent.co-worker.tech {
	reverse_proxy 127.0.0.1:42069
}
```

The application route is owned by `@flue/github`. It reads the exact request
bytes, verifies `X-Hub-Signature-256` with the managed Planner App webhook
secret, and only then parses or admits the payload. An unsigned public probe
returns HTTP 401.

## GitHub App configuration

The App is `Ambient Planner` (`ambient-planner`). Its repository permissions
remain the existing minimum: Issues read/write, Pull requests read-only, and
Metadata read-only. Its webhook is active with SSL verification enabled and is
subscribed to exactly:

- Issues
- Pull request
- Pull request review

The active webhook signing secret is stored only in the rig's managed
`github-planner.json` credential and the GitHub App hook. During setup, a local
capture was rejected because GitHub renders the secret field in clear text; the
credential was immediately rotated and that capture is not PR evidence. No
secret value appears in this repository, GitHub evidence, or the redacted
operational receipts below. URL/secret rotation uses an App JWT with GitHub's
`PATCH /app/hook/config` endpoint; event subscriptions are changed in the GitHub
App's Permissions & events settings.

## Trust boundaries

- Cloudflare owns public DNS and edge transport; the explicit hostname avoids
  changing the existing Railway service.
- Caddy admits the public hostname and proxies to loopback. Port 42069 is not a
  public webhook URL.
- GitHub's delivery signature is checked over exact bytes before JSON parsing.
- The provider delivery GUID is the durable ingress identity, so redelivery is
  deduplicated before Speaker dispatch.
- Operational receipts redact the Managed Chat identifier, credential paths,
  authorization headers, payload bodies, and webhook signatures.

## Operational checks

These checks expose no credentials:

```sh
dig +short ambient-agent.co-worker.tech A

curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST -H 'Content-Type: application/json' --data '{}' \
  https://ambient-agent.co-worker.tech/channels/github/webhook
# 401: the public route reached the application signature gate

sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
sudo systemctl is-active caddy
curl -fsS http://127.0.0.1:42069/health
```

GitHub App delivery inspection uses an App JWT and the read-only
`GET /app/hook/deliveries` endpoint. Print only delivery GUID, event, action,
delivery time, status, and HTTP status. Never print request/response payloads or
headers.

The pre-#174 Caddy configuration is retained on the rig as
`/etc/caddy/Caddyfile.before-issue174-20260718`. Rollback removes the explicit
Cloudflare record, restores that file, reloads Caddy, and removes the dedicated
443 firewall allowance. Do not remove or modify the existing Railway records.

## Live GitHub deliveries

No locally signed or synthetic payload qualifies for this section.

### `issues.opened` -> broadcast Speaker dispatch

A real public proof issue was opened and then closed after capture:
[issue #219](https://github.com/AaronAbuUsama/ambient-agent/issues/219).
GitHub recorded the following App delivery:

```json
{
  "deliveryId": "3831983788892626944",
  "guid": "38ee792a-82e7-11f1-959e-7ce606dfe5da",
  "event": "issues",
  "action": "opened",
  "deliveredAt": "2026-07-18T20:28:24.082Z",
  "status": "OK",
  "statusCode": 200,
  "redelivery": false,
  "repository": "AaronAbuUsama/ambient-agent",
  "subjectNumber": 219
}
```

The same provider GUID settled as `done` in
`github_ingress_deliveries` at `2026-07-18T20:28:24.031Z`, with no error. The
redacted runtime receipt reported `broadcastChats: 1`, ambience `ambience`, and
dispatch ID `e097f4af-cfd7-4d9b-9c1a-595d83cc4c1d` while Speaker was online.
The Managed Chat identifier is deliberately omitted.

### `pull_request_review.submitted` -> normalized continuation ingress

This receipt is captured from the ready PR after a real Reviewer App review is
submitted, so the proof is tied to the implementation's actual PR head.
