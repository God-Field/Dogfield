# Behavior accuracy

This page summarizes how closely Dogfield follows the HTML5 client and server. The Flash clients use separate versioned rules and protocols; see [Flash documentation](FLASH.md).

## Matches official client and published rules

- The TypeScript browser client ports the official HTML5 client flow, rendering, command UI, and protocol fields.
- The item catalog, translations, and published rules follow the in-game reference data.
- Battle validation, card effects, combinations, curses, guardians, phenomena, and event ordering are implemented in the shared engine and server, with local regression coverage for many interactions.

## Strongly supported

- Training bot names follow the official generator across supported locales.
- Duel rating updates follow the observed zero-sum formula; the local rating tests include observed official game results.
- Captured common battle transitions and wire fields are replayed by the oracle verifier when the corresponding logs are supplied.

## Approximate

- Bot card selection, defense choices, and targeting approximate observed decisions. Exact weights and the official random stream are unknown.
- Undocumented random choices and timing boundaries use the current local model; they are not established by Bible text or client code alone.
- Player-count expiry and inactivity handling follow observed windows, but are not a complete recreation of the production presence system.

## Unknown

- The purpose and any side effects of the official `update-account` action.
- Official rating, auto-play, and abandonment outcomes when a player leaves a ranked match.
- Rare combinations and end-of-game edge cases that are not represented by the available tests or recordings.

## Intentional differences

- Local JSON persistence and bearer accounts replace Firestore and Firebase Auth.
- The browser client watches player-count updates, so counts refresh while the page is open.
- Player lists update immediately when room snapshots change instead of waiting for a later turn.

`npm test` verifies local implementation behavior. Official parity claims require the relevant recorded transition; the log corpus is not included in this repository. Implementation entry points are in `src/engine/`, `server/battle/`, and `server/rooms/`.
