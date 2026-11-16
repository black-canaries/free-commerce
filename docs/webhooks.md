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
