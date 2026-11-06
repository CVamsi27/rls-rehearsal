# HTTP API

Send `Authorization: Bearer <key>` on item requests and `Content-Type: application/json` on writes. The key maps to a workspace on the server. Requests carry the item ID and input fields only. The demo profile accepts the two keys in [the synthetic workspace fixture](../examples/workspaces.json).

| Method and path | Input | Successful response |
| --- | --- | --- |
| POST /v1/items | `{"title":"Write the brief"}` | 201 and the new open item |
| GET /v1/items | None | 200 and up to 50 items, newest first |
| GET /v1/items/{id} | UUID path parameter | 200 and the item |
| PATCH /v1/items/{id} | `{"status":"closed"}` | 200 and the closed item, including on repeats |
| GET /healthz | None | 200 if the process is serving |
| GET /readyz | None | 200 if the runtime role and required tables pass verification |

Each item includes `id`, `title`, `status`, and an ISO UTC `createdAt`. Titles are trimmed and must contain 1–120 UTF-16 code units after trimming. Writes reject unknown fields. Errors carry `{"error":{"code":"not_found","message":"Resource not found."}}` for both an absent item and an item owned by another workspace. Other stable codes include `invalid_input` (400), `unauthorized` (401), `payload_too_large` (413), `unsupported_media_type` (415), `internal_error` (500), and `database_unavailable` (503). Every response gets an `X-Request-Id`.

```sh
ATLAS_KEY="$(node -p 'require("./examples/workspaces.json")[0].key')"
curl --fail-with-body -sS http://127.0.0.1:3100/v1/items \
  -H "Authorization: Bearer $ATLAS_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Write the brief"}'
curl --fail-with-body -sS http://127.0.0.1:3100/v1/items \
  -H "Authorization: Bearer $ATLAS_KEY"
```
