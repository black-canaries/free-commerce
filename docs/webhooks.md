# Verifying webhooks

Every delivery is a `POST` with a JSON body `{ id, type, createdAt, data }` and three headers:

| Header | Value |
| --- | --- |
| `webhook-id` | The event id. Identical on retries and replays: store it and ignore ids you have already processed. |
| `webhook-timestamp` | Unix seconds when this attempt was signed. |
| `webhook-signature` | One or more space-separated `v1,<base64>` values. |

The signature is `base64(HMAC-SHA256(secret, "<webhook-id>.<webhook-timestamp>.<raw body>"))`, where `secret` is the whole `whsec_...` string used as UTF-8 bytes.

To verify: compute the HMAC over the **raw** request body, compare in constant time, and reject timestamps more than 5 minutes from your clock. With the core package, `verifyWebhook({ secret, id, timestamp, signature, body, now })` does all three. Return any 2xx quickly; anything else (or no answer within 10 s) is retried after 1 min, 5 min, 30 min, 2 h and 12 h, after which the endpoint is disabled and the reason is shown in the admin. Redirects are not followed.

The signing secret is shown once when the endpoint is created.

Notes:

- The scheme follows the Standard Webhooks layout (same headers and signed content) but keys the HMAC with the whole `whsec_...` string as UTF-8, not the base64-decoded bytes, so stock Standard Webhooks libraries will not verify it. Use `verifyWebhook` or the recipe above.
- A manual replay keeps the original `webhook-id`. A receiver that dedupes on it will skip a replay of an event it already processed; replay is for deliveries the receiver missed.
- When an endpoint is disabled after repeated failures, its other pending deliveries wait and resume when it is re-enabled. Events that occur while it is disabled are not queued.
- Targets must be https on port 443 or 8443 and resolve to public addresses.
