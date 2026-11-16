# Architecture

## Runtime

- `src/engine/` and `src/domain/` contain shared headless game rules and data models.
- `src/` contains the browser client and its local-server adapter.
- `server/` owns accounts, rooms, matchmaking, bots, persistence, HTTP/SSE, and authoritative battle transitions.
- `server/flash/` hosts the separate 2013 and 2010 Flash game protocols and rules.
- `public/` contains browser assets and the patched Flash movies.

The server imports the shared engine through `server/engine-entry.ts`. The build bundles the browser app as `dist/main.dart.js`.

## Local service

The browser client sends actions to `POST /api/functions/<action>` with a local bearer token. It reads documents through `GET /api/doc` and subscribes to updates through `GET /api/watch` (SSE). The routes retain the document paths and wire fields the client expects.

The server saves accounts, rooms, chat, bans, and Duel records to `.local-server/state.json`. This JSON store and local bearer accounts replace Firestore and Firebase Auth. They do not share production accounts or data.

| Route | Purpose |
| --- | --- |
| `POST /api/auth` | Create a local account |
| `DELETE /api/auth` | Delete the caller's local account |
| `POST /api/functions/<action>` | Run a room or game action |
| `GET /api/doc?path=...` | Read an authorized document |
| `GET /api/watch?path=...` | Subscribe to document snapshots |

## Checks

```sh
npm run typecheck
npm test
```

`npm test` runs local client, engine, and server tests without contacting production services or reading live logs. `npm run test:browser` uses a local Chromium executable. Flash and APK checks are separate: `npm run test:flash:browser`, `npm run test:flash:parity`, and `npm run test:apk`.

The oracle verifier compares local replay against JSONL recordings supplied through `--logs=...`; `--oracle` writes a parity report. Bot verification accepts the same external corpus through its options and `REFACTOR_ROOT`. No official-service logs are bundled here.
