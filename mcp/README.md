# Ceylon Hop quote MCP (prototype, staging only)

Paste a customer's WhatsApp message into Claude and say "make a quote for this". Claude reads the
message, looks up the places, prices the trip, and saves it as a **draft** in the ops queue. You then
open the draft in ops, check it, and review/approve/send it exactly as today.

What Claude can do through this MCP:

| Tool | What it does |
|---|---|
| `search_places` | Looks up a place name in the ops place list |
| `estimate_quote` | Prices a trip **without saving** (use it to compare car vs van, private vs chauffeur) |
| `save_quote_draft` | Saves the trip as a draft quote, assigned to you |
| `get_quote` / `list_quotes` | Reads quotes back from the queue |

What it **cannot** do, on purpose: approve, discount, create pay links, book, or send. Customer
messages are untrusted text, so a person always does those steps in ops.

## How it signs in (prototype)

It uses **your own ops session cookie** (`ch_ops`), so quotes are created as you and the API's normal
permission rules apply. The cookie lasts **7 days**; when it expires Claude will tell you, and you
paste a fresh one. The MCP **refuses to talk to production** — staging (or localhost) only.

> Treat the cookie like a password: it carries your full ops access on staging. Don't share it or
> commit it.

## Setup (once)

1. **Install** (needs Node 20+):
   ```sh
   cd ceylon-hop/mcp && npm install
   ```
2. **Get your cookie.** Sign in at <https://ops.staging.ceylonhop.com/ops> in Chrome → DevTools
   (⌥⌘I) → **Application** → **Cookies** → `https://ops.staging.ceylonhop.com` → copy the **Value**
   of `ch_ops`. (It's HttpOnly, so it does not show up in `document.cookie`.)
3. **Connect it to Claude**, either way:

   **Claude Desktop:** Settings → Developer → Edit Config, and add (use your real absolute paths):
   ```json
   {
     "mcpServers": {
       "ceylon-hop-quotes": {
         "command": "/ABSOLUTE/PATH/ceylon-hop/mcp/node_modules/.bin/tsx",
         "args": ["/ABSOLUTE/PATH/ceylon-hop/mcp/src/index.ts"],
         "env": { "CEYLON_HOP_OPS_COOKIE": "paste-the-ch_ops-value-here" }
       }
     }
   }
   ```
   Restart Claude Desktop. If it can't find `node`, put the full path to `node` in `command` and
   move the tsx path into `args` first: `"args": ["…/node_modules/.bin/tsx", "…/src/index.ts"]`.

   **Claude Code:**
   ```sh
   claude mcp add --transport stdio \
     --env CEYLON_HOP_OPS_COOKIE=paste-the-ch_ops-value-here \
     ceylon-hop-quotes -- /ABSOLUTE/PATH/ceylon-hop/mcp/node_modules/.bin/tsx /ABSOLUTE/PATH/ceylon-hop/mcp/src/index.ts
   ```

Optional: `CEYLON_HOP_API_BASE=http://localhost:8787` to point at a local API instead of staging.

## Using it

> Here's a WhatsApp message, can you quote it? "Hi! 2 of us landing at CMB on 3 Dec, need to get to
> Ella, 2 big bags"

Good habits: ask Claude to **estimate first** and show you the options, then say "save it". It
should ask you when the message is missing a date, passenger count, or a place it can't find.

## Development

```sh
npm run check   # typecheck + tests (tests use a fake API; nothing is sent anywhere)
```

The trip shape mirrors `ToolRequestSchema` in `api/src/routes/internalQuote.ts`. If that schema
changes, update `src/server.ts` to match (the API re-validates, so drift shows up as a 400, not a
wrong price).
