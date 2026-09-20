# Portcall

A small plugin gateway that serves local MCP servers over HTTP.

The name is a nautical pun: *port call* — `port` (harbour / network port) + `call`
(a ship's stop / a request).

## What it is

Portcall listens on one HTTP port and mounts one or more MCP servers at separate
paths:

```
/vault/mcp   → mcpvault (Obsidian vault)
/healthz     → liveness + mount list
```

Each mount is an independent MCP endpoint. Clients register them separately —
there is no tool aggregation, so no name collisions and no namespacing scheme to
maintain.

Exposing the port beyond localhost is deliberately out of scope. Put a tunnel,
reverse proxy, or nothing at all in front of it; Portcall binds to `127.0.0.1`
by default and does not care what is upstream.

## Why not a stdio bridge

The obvious way to put a stdio MCP server on HTTP is a generic bridge such as
`supergateway`. That works, but it has a structural problem: every request or
session spawns a child process, and reaping those children is easy to get wrong.

In `supergateway` specifically, the child is only reclaimed from
`transport.onclose` or `transport.onerror`. Nothing calls `transport.close()` on
a normally-completed stateless request, so `onclose` never fires and **every
successful request leaks a process** — only failed requests get cleaned up. Its
stateful mode does not leak (a session timer closes the transport), but it holds
a long-lived `GET` SSE stream instead, which some proxies handle badly.

Wrapping the command in `npx` makes it worse: `npx` forks the real server, so
killing the child kills the wrapper and orphans the grandchild.

Portcall's answer is to not spawn anything when it does not have to.

## Adapters

| Adapter | For | How |
|---|---|---|
| `inProcess` | Servers that export a factory as a library | Calls the factory in-process. No child process exists, so there is nothing to reap. |
| `stdio` | Third-party servers that only speak stdio | Not implemented yet. When it lands it must reclaim the child on normal completion, not just on error, and handle process-group kills for wrapper commands. |

`inProcess` is the interesting case and covers the servers worth self-hosting.
`@bitbonsai/mcpvault`, for example, exports `createServer(vaultPath, options)`
returning an MCP SDK v2 `Server`; its `bin` entry is essentially
`serveStdio(() => createServer(...))`. Portcall calls the same function directly
and skips stdio entirely.

The SDK builds a fresh server instance per request and disposes it with the
request, so there is no session state to time out and no accumulating handles.

## Abuse control

A client that fails authentication `PORTCALL_GUARD_FAILURES` times inside the
window is blocked for `PORTCALL_GUARD_BLOCK_MS`, on every path, whatever token
it presents afterwards. A separate cap refuses more than `PORTCALL_GUARD_RATE`
requests per client per window. Rejections always reach the log, with the
client and — when a block trips — how long it lasts.

This belongs here rather than at the CDN because only this process knows
whether a token was *right*. Five wrong tokens is a far sharper signal than
five hundred requests, and an edge rate limit cannot tell them apart. An edge
limit is still the better answer to a volumetric flood, which this cannot
help with: by the time the request is counted here it has already crossed the
link. The two do not overlap.

Clients are told apart by `cf-connecting-ip`, which is trustworthy only
because the listener is bound to loopback — nothing but the local tunnel can
deliver a request, so nothing else can forge the header. Bound to a public
interface the header is ignored and the socket address is used instead;
believing it there would let one caller be blocked under another's address.

State is in memory and dies with the process, so a restart forgives everyone.
That is deliberate: the worst outcome for a personal gateway is locking out
its owner.

## Plugins

| Mount | Serves |
|---|---|
| `/vault/mcp` | `@bitbonsai/mcpvault` over the Obsidian vault at `PORTCALL_VAULT_PATH`, plus image and history tools |
| `/kis/mcp` | Korea Investment & Securities overseas-stock quotations, read-only |

### Vault images

mcpvault reads and writes notes but has nothing for attachments, so an
embedded screenshot arrives as the literal text `![[shot.png]]` and the image
itself is unreachable. Four tools fill that in:

- `read_image` returns an attachment as an image, so it can actually be looked
  at. It takes a vault-relative path or the bare filename an embed uses, and
  resolves the latter the way Obsidian does — an ambiguous name is reported
  with its candidates rather than guessed at. The file in the vault is never
  touched: resizing and conversion happen on a copy in a temporary directory.
  SVG comes back as its source, being markup.
- `find_images` lists attachments with their size, dimensions and what uses
  them, and filters by name, folder, orphans (nothing links to it) or broken
  embeds (no file behind the link). Dimensions are read from the file header
  rather than by shelling out per file.
- `write_image` saves an image from base64, a URL or a local file, and can
  append the Obsidian embed to a note.
- `delete_image` removes an attachment, for clearing out the orphans
  `find_images` turns up.

These are merged into mcpvault's tool listing rather than mounted separately,
so the vault stays one connector. mcpvault registers `tools/list` and
`tools/call` on a low-level `Server`, which leaves no seam to register extra
tools into, so `merge.ts` fronts it over a linked in-memory transport and
routes each call to whichever side owns the name.

#### What counts as using an image

An image is in use if a note embeds it, if a note names it in frontmatter as
a cover or a banner, or if a canvas puts it on a board. Only the first can
report a link as *broken*: frontmatter is read by pattern rather than parsed
as YAML, so an over-eager token there would invent a missing file. Reading it
loosely is still worth it in the other direction, where the cost of missing a
reference is calling a file an orphan when it is not — and `delete_image`
refuses an image anything still uses.

#### Returning an image

Re-encoding is done with `sips`, which ships with macOS: the daemon is a
personal service on one Mac, so that is one less native dependency to build
and keep current. An image already within the pixel and byte budget is sent
untouched, which also means an animated GIF still animates.

When re-encoding is unavoidable, the source format decides the target,
because it is the best available hint about the content. Measured on a
4032×3024 photo and a 3000×2000 screenshot:

| Source | Sent as | Keeping it | Switching |
|---|---|---|---|
| JPEG photo | JPEG | 1,056 kB | 2,930 kB as PNG |
| HEIC photo | JPEG | 1,086 kB | 3,005 kB as PNG |
| PNG screenshot | PNG | 33 kB | 75 kB as JPEG |

So JPEG, HEIC and AVIF are re-encoded as JPEG; PNG, GIF, TIFF, BMP and ICO as
PNG. `sips` cannot write WebP, so a WebP that has to be re-encoded becomes
PNG, with JPEG behind it because a WebP is as likely to be photographic. If
the result still will not fit, the longest edge is halved, twice.

#### Fencing in the writes

- Every path is resolved against the vault root and anything that climbs out
  is refused.
- The bytes are sniffed and must be a real image that agrees with the
  destination extension. A name is not evidence.
- An existing file is never replaced unless `overwrite` is passed, and
  `delete_image` needs the path repeated in `confirmPath`.
- A URL import is http(s) only and must answer with an `image/*` type.
  Redirects are followed by hand, up to four, so that **every hop** is checked
  against private addresses — a public host that redirects to a private one
  gets no further than the check. The daemon is reachable from the internet
  through a tunnel, and this stops it being used to reach into the network it
  sits in. `fetch` resolves again after each check, so this narrows the hole
  rather than closing it.
- Copying from a local path is off until `PORTCALL_VAULT_IMPORT_DIRS` names
  the folders it may read. The mount otherwise touches nothing outside the
  vault, and that is worth keeping deliberate.

A read-only mount serves `read_image` and `find_images`, and withholds
`write_image` and `delete_image`.

### Vault history

The vault is a git repository with a job snapshotting it on a timer, and
mcpvault only ever sees the working tree. Four tools read what is behind it:

- `vault_changes` summarises a window: one row per note, with how much was
  added and removed and when it was last touched, newest first. Attachments
  and Obsidian's own files — `.obsidian/`, `.trash/`, a dotfile at the root —
  are counted in their own buckets rather than among the notes. They are still
  reported: someone who toggled a plugin should not be told nothing happened.
  What is and is not vault content is decided by `paths.ts`, the same list the
  image tools walk with, so the two cannot come to disagree about it.
- `note_history` lists the snapshots that touched one note, follows it through
  renames, and finds notes that are no longer in the vault.
- `note_diff` returns the lines that changed between two points.
- `note_at` returns a note as it stood. This is also how one is recovered —
  read it here, write it back with mcpvault's `write_note` — which is why
  there is no restore tool. A recovery is then an ordinary edit, visible in
  the next snapshot like any other.

A vault that is not a git repository gets none of these, the way the KIS mount
serves quotations only until an account is configured. A listed tool that
always fails is worse than one that was never listed.

#### Why a window is not a list of commits

Snapshots are taken on a timer, so a commit boundary is where the clock fell
rather than where a thought ended. One sitting is scattered across several
commits, each titled `snapshot <time>`, and listing them shows the same note
four times while saying nothing about it. `vault_changes` compares the two
ends of the window instead, and `note_history` is what answers at commit
resolution — which is the question a commit boundary is actually good for
(*when did that paragraph go*).

#### Three things that would otherwise be quietly wrong

- **A Korean path comes back escaped.** By default git prints anything
  outside ASCII as `"\355\225\234..."`, which then matches no file in the
  vault. Every call sets `core.quotePath=false`.
- **git does not reject a date it cannot read.** `--before=<value>` falls back
  to the current time, so a typo would be answered with *nothing changed*
  rather than with the typo — the worst shape an error can take. The value
  goes through `rev-parse --since` first and one that comes back as now is
  refused, which is what happens to `지난주` or `yesterdya`. What cannot be
  caught is a near miss git half-understands: `last tuseday` quietly becomes a
  real date. So the moment a date resolved to is reported in the answer, where
  a wrong reading is at least visible.
- **A note renamed after the window closed.** Inside that window the note only
  ever had its old name, so asking by the name it has today would report no
  change across its entire earlier life — and disagree with `note_history`,
  which does follow renames. The diff is taken against every name the note has
  had.

`GIT_OPTIONAL_LOCKS=0` is set on every call so that a read never takes the
index lock: the snapshot job commits on a timer, and a model asking what
changed should not be why that fails.

A rename combined with a heavy rewrite falls below git's 50% similarity
threshold and reads as a delete and an add. That is left at git's default
rather than loosened — a vault of notes started from the same template would
otherwise start reporting renames between unrelated ones.

### KIS

Quotation tools, which need no account: `overseas_quote`,
`overseas_quote_detail`, `overseas_daily_prices`, `overseas_orderbook` (ten
levels a side, with the session summary), `overseas_history` (long cached
series as CSV), `fx_rate` (exchange rate history for 14 currencies against
the dollar) and `overseas_index` (Dow, Nasdaq Composite, Nasdaq 100,
S&P 500).

Account tools, registered only when `KIS_ACCOUNT` is set: `overseas_balance`
(the whole account in one call — every position, cash and margin per
currency, and totals including withdrawable cash), `overseas_holdings`
(one exchange at a time, for its per-exchange totals), `overseas_executions`
(order and fill history, this year by default) and `overseas_realized_pnl`
(realised gains per disposal with FX rates). Prices are public and a portfolio
is not, so the two are opt-in separately.

There is no capital gains tax tool because KIS exposes no tax API.
`overseas_realized_pnl` returns the disposal-level record a filing is built
from; the filing figures themselves come from KIS's own year-end statement.

Read-only is enforced three ways. No ordering tool is implemented, so none can
be called; the client refuses any path outside the allowlist; and within a
trading namespace — where account inquiries sit alongside the order endpoints
— it refuses any tr_id that is not an inquiry. KIS ends inquiry tr_ids with
`R` and orders with `U` (`TTTS3012R` reads a balance, `TTTT1002U` buys). All
three are covered by tests.

There is one trading namespace per market, and the guard holds a list rather
than the overseas one alone. Only overseas endpoints are mounted today, but a
domestic account inquiry added against a single-namespace guard would take
the tr_id check out with it and be waved through on the allowlist alone —
the guard going quiet rather than failing.

The access token needs care rather than cleverness. KIS issues one valid for 24
hours but refuses a re-issue within a minute of the last (`EGW00133`), so the
store lives for the process rather than the request — `inProcess` builds a
fresh server per request — mirrors the token to `~/.cache/portcall/` so a
restart does not spend an issue, and collapses concurrent cold-start callers
into a single request.

Account queries are paged: KIS signals more rows with `tr_cont` of `F` or `M`
and expects the next request to echo the cursor from the previous body. The
client walks that automatically, up to a page ceiling.

The cursor's parameter name is not uniform — most account inquiries take
`CTX_AREA_FK200`, the daily ledger takes 100, the rights calendar 50 — so
each endpoint declares its own and one that does not page declares that
instead. Sending the wrong width is not rejected: KIS drops parameters it
does not recognise and replays the first page, which ends the walk on the
repeated-cursor guard with the rest of the rows never fetched. Paging an
endpoint that returns a single page is refused outright for the same reason,
since handing back one page as though it were all of them is the failure that
cannot be seen from the outside.

`overseas_history` exists because backtesting wants more bars than a quote
tool should hand back. Nineteen years of daily bars is 4,801 of them, which
is forty-nine round trips at a hundred a page — tolerable once, absurd on
every request, and the answer never changes: a bar from 2014 is settled. So
the series is assembled once into `~/.cache/portcall/history/`, and after
that only its tail is refreshed.

Three things follow from that, and each is a thing that would otherwise be
quietly wrong:

- **A split rewrites history.** Adjusted prices are restated all the way
  back, and the leveraged ETFs this exists for split often. Every request
  re-reads the newest page anyway; comparing it against what is stored turns
  that call into the staleness check, and a disagreement throws the series
  away rather than serving a wrong one.
- **A long gap leaves a hole.** Unused for more than a hundred sessions and
  the newest page no longer touches what is stored. The walk closes the gap
  before the two halves are joined, so the series is never discontinuous.
- **The wrong venue looks like no data.** SOXL lists on `AMS` while SOXX,
  TQQQ and QQQM list on `NAS`, and asking the wrong one returns an empty page
  rather than an error. `exchange` can therefore be left out: the US venues
  are tried in turn and the answer is remembered.

Bars come back as CSV — `date,open,high,low,close,volume`, oldest first —
rather than as a JSON object per bar. The quote tools return fourteen fields
including a bid/ask snapshot that means nothing on a daily bar; dropping the
nine a price series cannot use takes a bar from 284 bytes to 65. Nineteen
years is 231 kB instead of 1.3 MB. Weekly is 48 kB and monthly 11 kB, so a
whole span costs almost nothing at those sizes. A call is capped at 1,200
bars by default and says when it clipped.

History begins 2007-08-20 on this endpoint whatever the listing date —
checked against several symbols, including ones listed decades earlier.

The chart endpoint behind `fx_rate` and `overseas_index` has no such cursor,
and caps a call at 100 rows without saying so: a request for three years of
daily bars comes back as the most recent hundred sessions, carrying the dates
that were asked for. Read as-is that says the series begins in April. Both
tools therefore report `covered` — the span the rows actually span — and set
`truncated` when a full page stopped short of the requested start. A short
page is KIS having nothing more, not KIS holding back, so only a full one is
flagged.

The won/foreign-currency flag is not consistent across KIS endpoints: the
consolidated balance reads `01` as won, while the realised P&L endpoint reads
`02` as won. Both were confirmed against the live API rather than the
published parameter tables, and the tools present a single `report` option so
the inconsistency stops at this boundary.

Exchange rates are not all quoted the same way round: most pairs are units
per dollar, but EUR, GBP and AUD are dollars per unit, so `fx_rate` states the
direction in `quotedAs` rather than leaving it to be inferred.

Values come back as strings, exactly as KIS sends them; `decimals` says how
many places the venue quotes to. Quotes are delayed unless the account carries
a real-time subscription. Note also that the quotation and account APIs use
different exchange codes — `NAS` quotes Nasdaq, `NASD` covers the whole US
market on an account query — so the tools keep the two sets apart.

## Protocol versions

Portcall is built on `@modelcontextprotocol/server` v2, which serves two
protocol eras from a single handler:

- **Modern (`2026-07-28`)** — per-request envelope. Requests carry
  `MCP-Protocol-Version`, `Mcp-Method`, and (for tool calls) `Mcp-Name` headers
  plus a `params._meta` block. There is no `initialize` handshake and no
  long-lived session; discovery is `server/discover`.
- **Legacy (2025-era)** — served statelessly by default. `GET` and `DELETE`
  (2025 session operations) answer `405`. Set `PORTCALL_MODERN_ONLY=true` to
  reject legacy traffic outright.

Because the modern era is per-request, there is no standing SSE stream to keep
open. That sidesteps a class of proxy problem: some reverse proxies withhold
response headers until the first body byte arrives, which stalls a
just-opened-but-silent SSE stream indefinitely. For the streams that do occur,
`PORTCALL_KEEPALIVE_MS` controls the SSE comment-frame interval; lower it if a
proxy in front is buffering.

## Configuration

All host-specific values come from the environment.

| Variable | Default | Meaning |
|---|---|---|
| `PORTCALL_VAULT_PATH` | *(required)* | Absolute path to the Obsidian vault to serve |
| `PORTCALL_VAULT_IMPORT_DIRS` | *(unset)* | Colon-separated folders `write_image` may copy from, `~/` expanded. Unset means none |
| `PORTCALL_PORT` | `7100` | TCP port |
| `PORTCALL_HOST` | `127.0.0.1` | Bind interface |
| `PORTCALL_TOKEN` | *(unset)* | Static bearer token. Unset means no authentication |
| `PORTCALL_ALIAS_ROOT_MCP` | *(unset)* | Also mount the named plugin at `/mcp` |
| `PORTCALL_PATH_PREFIX` | *(unset)* | Serve every mount under `/<prefix>/…` |
| `PORTCALL_KEEPALIVE_MS` | `15000` | SSE keepalive interval; `0` disables |
| `PORTCALL_MODERN_ONLY` | `false` | Reject 2025-era requests instead of serving them |
| `PORTCALL_GUARD_FAILURES` | `5` | Auth failures from one client before it is blocked; `0` disables |
| `PORTCALL_GUARD_WINDOW_MS` | `300000` | How far back those failures are counted |
| `PORTCALL_GUARD_BLOCK_MS` | `900000` | How long a blocked client stays blocked |
| `PORTCALL_GUARD_RATE` | `600` | Requests per client per window; `0` disables |
| `PORTCALL_GUARD_RATE_WINDOW_MS` | `60000` | The rate window |
| `PORTCALL_LOG_HEADERS` | `false` | Log every request header, with anything unrecognised reduced to a sketch |
| `KIS_APP_KEY` | *(unset)* | Korea Investment app key. Unset leaves the KIS mount off entirely |
| `KIS_APP_SECRET` | *(required with the key)* | App secret paired with `KIS_APP_KEY` |
| `KIS_ACCOUNT` | *(unset)* | Account number, `12345678-01`. Unset serves quotations only |

`PORTCALL_TOKEN` gates every mount with `Authorization: Bearer <token>`. Note
that some MCP clients — Claude's custom connector UI among them — offer no way
to set a request header, so for those the token has to be enforced upstream
instead (or left off, with access controlled at the network layer).

`PORTCALL_PATH_PREFIX` is the fallback for exactly those clients: it moves every
mount under a segment you choose, so `/vault/mcp` becomes `/<prefix>/vault/mcp`
and the URL itself carries the secret. Two things follow from that, and the
server enforces both:

- `404` responses say only `not_found`. They never list what is mounted.
- The mount listing moves out of the public `/healthz` and into
  `/<prefix>/healthz`. The bare `/healthz` still answers, so liveness probes
  keep working, but it discloses no paths.

The authenticated health payload also reports `blockedClients`, the number of
clients the guard is currently holding off. It sits behind the same gate as
the mount list: it is for whoever runs this, and it would otherwise tell a
caller whether their guessing had been noticed.

Treat a path prefix as weaker than a header. URLs reach proxy access logs,
crash reports, and anything that records a destination, and a leaked one grants
the same access a leaked token would. It raises the bar — it is not
authentication.

This log is the one destination the process does control, so the prefix is
reduced there the same way a token is: request lines and the startup banner
read `/<prefix a1b2c3d4>/vault/mcp`, which still says which mount was hit. A
path that does not carry the prefix is logged as it came, because that is the
caller's guess rather than the secret.

`PORTCALL_LOG_HEADERS=true` writes out every header a request carried, for
bringing up a new client. What it prints is an allowlist: the ordinary
addressing and content headers in the clear, `Authorization` as its scheme
plus a length and digest, and everything else as a length and digest alone.
Deciding what to print rather than what to hide is deliberate — a blacklist of
key names only catches the secrets someone thought of, and the one that got
out of this project was stored under the key `value`.

Which plugins are mounted, and where, is declared in `plugins.config.ts`.

## Running

Requires Node 24 (see `.nvmrc`).

```bash
npm install
npm run build
cp .env.example .env    # then set PORTCALL_VAULT_PATH
npm start
```

Both `npm start` and `npm run dev` load `.env` if it is present and start
without it if it is not, so a daemon can inject the environment directly
instead. Variables already set in the environment are not overridden.

`npm run dev` runs the entry point through `tsx` with watch. A daemon should
run the built output, not `tsx`.

Check it is up:

```bash
curl -s localhost:7100/healthz
```

## Tests

```bash
npm test        # builds, then runs unit and integration tests
npm run typecheck
```

No test dependencies: the runner is `node:test`, and `tsx` (already needed for
`npm run dev`) loads the TypeScript.

The integration tests are black-box. They spawn the built server against a
throwaway vault on an ephemeral port and drive it over real HTTP, so they
exercise the same artifact a daemon runs — routing, the `/mcp` alias, bearer
auth, and both protocol eras. The unit tests cover mount resolution and the
bearer check, where a silent regression would look like a dead client rather
than an error.

## Layout

```
src/
  server.ts            HTTP entry point, wiring, health, shutdown
  routes.ts            mount resolution and URL normalisation
  auth.ts              bearer token check
  config.ts            environment parsing
  log.ts               structured logging
  types.ts             the Plugin interface
  adapters/
    inProcess.ts       library-factory adapter
  plugins/
    vault/             mcpvault plus image and history tools
      index.ts         plugin factory
      merge.ts         fronts mcpvault so extra tools share the mount
      image.ts         read_image, find_images, write_image, delete_image
      git.ts           vault_changes, note_history, note_diff, note_at
      media.ts         format sniffing, header dimensions, sips re-encoding
      paths.ts         vault confinement, walking, embed/frontmatter/canvas refs
    kis/               Korea Investment quotations (read-only)
      index.ts         plugin factory, process-lifetime token store and client
      client.ts        quotation allowlist, headers, throttle, error mapping
      history.ts       cached long price series, paging, split detection
      token.ts         access-token cache (memory + disk)
      tools.ts         the quotation tools
plugins.config.ts      which plugins mount at which paths
test/
  integration.test.ts  black-box tests against the built server
  routes.test.ts       mount resolution
  auth.test.ts         bearer token check
  kis-token.test.ts    token caching, single-flight, restart reload
  kis-client.test.ts   allowlist, headers, paging, KIS error surfacing
  kis-tools.test.ts    the tool set, read-only hints, Korean business dates,
                       the order book ladder, chart-range coverage, CSV history
  kis-history.test.ts  paging, the disk cache, split detection, venue lookup
  vault-media.test.ts  header parsing, format sniffing, reference extraction,
                       extension aliases, the private-address filter, download caps
  vault-image.test.ts  the image tools, driven through the merged server,
                       plus what survives an upstream that goes away
  vault-git.test.ts    the history tools against a fixture repository:
                       Korean paths, unreadable dates, renames, deleted notes
  helpers.ts           server harness and MCP request builders
```

## License

MIT
