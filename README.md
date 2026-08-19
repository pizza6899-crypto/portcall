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
| `PORTCALL_PORT` | `7100` | TCP port |
| `PORTCALL_HOST` | `127.0.0.1` | Bind interface |
| `PORTCALL_TOKEN` | *(unset)* | Static bearer token. Unset means no authentication |
| `PORTCALL_ALIAS_ROOT_MCP` | *(unset)* | Also mount the named plugin at `/mcp` |
| `PORTCALL_KEEPALIVE_MS` | `15000` | SSE keepalive interval; `0` disables |
| `PORTCALL_MODERN_ONLY` | `false` | Reject 2025-era requests instead of serving them |

`PORTCALL_TOKEN` gates every mount with `Authorization: Bearer <token>`. Note
that some MCP clients — Claude's custom connector UI among them — offer no way
to set a request header, so for those the token has to be enforced upstream
instead (or left off, with access controlled at the network layer).

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
    vault.ts           mcpvault
plugins.config.ts      which plugins mount at which paths
test/
  integration.test.ts  black-box tests against the built server
  routes.test.ts       mount resolution
  auth.test.ts         bearer token check
  helpers.ts           server harness and MCP request builders
```

## License

MIT
