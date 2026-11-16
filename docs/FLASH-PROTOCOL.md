# Flash protocol coverage

The audit compares the supplied 2013 scripts and both May/August 2010 scripts with
`server/flash/`. The clients agree on the gameplay protocol except for the
version-specific messages below. All **referenced** response types and recognized
error names now have server emitters. A declared enum member alone does not prove
that a client implements a feature.

Run the local static comparison against user-supplied decompiled scripts:

```sh
npm run flash:audit-protocol -- --source=/path/to/2013/scripts --source=/path/to/201005/scripts --source=/path/to/201008/scripts
```

This checks references and emitter names, not payload semantics or historical
server behavior. The offline tests and real-SWF browser checks exercise the new
payloads, transitions and trigger conditions. They require no original files or
external services.

## Game entry rejections

`ModeEntryRejection` is our server's type, not an original client enum. All eight
values are emitted and covered by offline tests:

| Message | Trigger |
| --- | --- |
| `loginRequired` | Paid entry without a local account; charged 2010 room entry without an account. |
| `alreadyInGame` | Entry requested while that connection is already in a game. |
| `userExists` | Another session with the account or scoped name is queued or playing; duplicate Free Fight login. |
| `insufficientFunds` | Entry fee cannot be paid, including a balance change before pairing/start. |
| `invalidRequest` | Unsupported Spirit player count. The transport also uses this for malformed or invalid requests. |
| `caveLocked` | The previous Spirit cave has not unlocked the selected cave. |
| `paymentRequired` | A 2010 Spirit account does not meet the legacy `hasPaid` condition. |
| `opponentUnavailable` | A proposed participant can no longer enter; an otherwise eligible participant is returned to the lobby. |

The original paid-mode clients do not display dialogs for these codes. A preceding
`ENTER` restores their controls and `ERROR` re-enables input. `isLocked` is emitted
**only** while actual maintenance is enabled; it is not a fallback rejection.

## Socket responses

| Response(s) | Server support and trigger |
| --- | --- |
| `ENTER` | Login, lobby/room entry, return, recovery and rejected-entry resynchronization. |
| `ADD_USER`, `REMOVE_USER` | Scoped lobby/room membership changes. |
| `CHAT` | Room/team chat with per-recipient filtering. |
| `ADD_PLAYER`, `REMOVE_PLAYER` | Battle entry/exit, teams, ready and finished flags. |
| `START_GAME`, `END_GAME` | Authoritative battle lifecycle. |
| `START_INNING`, `END_INNING` | Turn lifecycle. |
| `RESET_ATTACK_ORDER` | Attack order changes; referenced by the 2013 client. |
| `DEAL` | Private inventory draws. |
| `COMMAND`, `BUY` | Authoritative action and purchase results. |
| `DISEASE`, `UNFOG`, `DYING`, `DIE` | Battle status, visibility and death effects. |
| `UNILLUSION` | 2013 Illusion visibility reveal. |
| `FINISH_GAME` | All participants finish a Free Fight/Training battle and the room resets. |
| `KICKED` | A strict majority of battle participants filters a user. Sent before the lobby `ENTER`, then `ERROR kicked`; this clears the client's room/movement state. |
| `SET_CHARGE` | 2010 Free Fight room fee toggle. Room recipients get `needsCharge`; lobby recipients also get `roomID`. Reconnect snapshots retain the flag. |
| `DRAW_BOOK` | A 2010 Free Fight encyclopedia draw; returns the original `index`. |
| `USERS` | Duel playing, waiting and other counts. |
| `STRAIGHT` | 2010 Duel streak metadata at pairing. |
| `SCORE_BONUS` | 2013 Duel score-bonus metadata at pairing. |
| `ERROR` | Explicit request/entry errors. |
| `EXIT` | Declared in all response enums, but never referenced by any receiver. Requests named `EXIT` are acknowledged with `ENTER`; an outgoing `EXIT` would add no client behavior. |

The 2013 response enum also declares `SET_CHARGE`, but none of its receivers uses
it and its request enum contains no corresponding command. The fee toggle is a
2010 feature, not a missing 2013 feature.

Free Fight room snapshots send other users in `ENTER`, followed by `ADD_USER` for
the recipient. The original room receiver stores `ENTER` users without drawing
the list; `ADD_USER` draws it. This sequence also applies to recovery and resync,
and includes each user exactly once.

Client-recognized error names are `userExists` (2013 Free Fight), `nameExists`,
`passwordIncorrect`, `kicked`, and `isLocked`. Each now has a real trigger.

## Legacy features completed by this audit

- `SET_CHARGE` is accepted only in an empty, unstarted 2010 Free Fight room. The
  fee is 125 local credits per participant, charged atomically at start. Winners
  split `100 × participant count` credits, matching the 2010 client constants and
  winner display. A free room never charges or pays out. Settlement is idempotent.
- Paid 2010 victories earn `floor(player count / winner count)` legacy book points,
  independently of the 2013 collection. A draw costs five points, uses one of the
  client's 434 indices, and returns `<DRAW_BOOK><index>…</index></DRAW_BOOK>`.
  `getBook?fcauth=…` returns legacy `element@index`, `count` and `text`; the modern
  `userID` route retains `element@id`. Both 2010 movies contain identical embedded
  category tables, copied as CSV under `server/flash/data/book-2010/`.
- The local draw policy chooses an unowned entry. A complete collection can reveal
  an existing entry for free, as allowed by the client's full-book button logic.
  A stale second-tab draw with insufficient points replays the last owned entry
  without another charge or grant, allowing the original reveal modal to finish.
- `addLoginBonus?fcauth=…` now persists a server-side 20-hour cooldown. The cooldown
  comes from the original entrance code. **50 local credits is our emulation
  policy**: the historical bonus amount is not encoded in the client. Successful
  claims return the amount; repeated claims return zero. No real currency is used.
- The service's in-process maintenance flag advertises `getUserCount=-1`, disables new Training game
  startup and rejects new paid entries/Free Fight readiness with `isLocked`.
  Existing games can finish; ordinary validation failures do not use the
  maintenance message.

## HTTP and external services

The client-used local game APIs are `getUserCount`, `getData`, `getCoin`, `drawLot`,
`addLoginBonus`, `getRecord`, `getSpiritResult`, `getDuelResult`, `getBook`, and
`addBookElement`. Each is implemented, with the legacy/modern payload distinctions
preserved. `DRAW_BOOK` remains a socket request in 2010.

The legacy Mogera-only `buyCharinByMoritapo` branch refers to an external payment
provider, not a game-server message. It is unreachable from the local launcher
(which provides no Mogera wallet credentials) and explicitly returns HTTP 501 if
requested with a local account. We do not fabricate a third-party purchase or
claim to support historical money transfers. `getData` and local play credits
remain available.

## Verification

```sh
npm run typecheck
node --import tsx --test server/tests/flash.test.mjs
npm run test:flash:protocol
npm run test:flash:protocol -- --version=201005
npm run test:flash:protocol -- --version=201008
```

The browser check exercises actual SWFs: kick/lobby/alert/Back transitions, actual
maintenance and re-entry, plus the 2010 login reward, book HTTP data and draw
animation, and charge-toggle request. The two-tab checks remain separate.

## Gameplay modeling audit (2026-11-16)

Compared the local Flash rules, command selection, consumption, resolution, and
battle-event payloads with the supplied 2013 decompilation at
`/tmp/dogfield-flash-source/scripts/`. Source paths below are relative to that
scripts directory; original client files are not needed by the tests.

| Discrepancy corrected | Client evidence |
| --- | --- |
| A 2013 discard command can contain multiple artifacts. Sale and item-add commands still accept only one additional artifact; 2010 retains its two-card discard limit. | `net/godfield/game/AttackCommand.as`: `canAdd`, `isEnough`. |
| Attribute removal persists through reflection/flick chains, including validation of later human and bot defenses. | `net/godfield/game/CommandChain.as`: `attackAttribute`; `net/godfield/game/DefenseCommand.as`: `getKind`. |
| Earth's redistributed artifacts lose their old Illusion identities. The authoritative inventory now agrees with both the private mystery result and reconnect snapshots. | `net/godfield/client/game/result/MysteryResult.as`: `end`; `net/godfield/client/game/item/ItemList.as`: `changeAllItems`, `fadeInItem`. |
| Selling a creature consumes two cards and creates two replacement covers, because its effective command kind is the creature's effect. Ordinary sales still create one cover. | `net/godfield/game/AttackCommand.as`: `kind`; `net/godfield/client/game/item/ItemList.as`: `consume`. |
| Pestle's tenfold Mortar multiplier caps attack power at 9999. | `net/godfield/game/AttackCommand.as`: `value`; `net/godfield/Constants.as`: `ATK_MAX`. |
| A request without an Illusion index selects a real artifact, even when a disguised artifact shares its displayed ID. Indexed requests select the specific disguised artifact; bots now send the same index. | `net/godfield/client/game/command/CommandOKButton.as`: `sendCommand`; `net/godfield/game/Command.as`: `toXML`; `net/godfield/client/game/item/ItemList.as`: `getIllusionItemIndex`. |

Seven focused offline regression tests cover these corrections, including human
and bot reflection defenses, multi-discard with an indestructible Mortar,
creature-sale replacement counts, capped attack power, revealed
Earth results, and ambiguous real/disguised item selection.

The old replay and lobby snapshot hashes already failed on unmodified `HEAD`.
Before refreshing them, a separate comparison replayed all 200 seeds on both
versions: 198 complete message/state streams were identical; seeds 61 and 160
first differed when a bot correctly used a defense after attribute removal in a
reflected chain. The refreshed replay fixture records every one of the 200 seeds
and uses current 2013 messages directly, without reconstructing the obsolete
forced-Illusion flag. The lobby snapshot digest was unchanged by this audit's
implementation changes.

Validation: `npm run typecheck`, `npm test` (505 tests), and
`npm run flash:audit-protocol -- --source=/tmp/dogfield-flash-source/scripts`
all passed. The static audit reports no missing referenced response emitters or
recognized error names. No real-SWF browser run was performed in this audit.

This establishes parity for the corrected client-visible transitions, not proof
of the historical server's hidden algorithms. Random selection probabilities,
Mystery distribution policies, and other server-only choices cannot be established
from client rendering/command code alone. The existing disease-event HP placeholder
is retained for anonymous Fog displays; it does not synchronize a named player's
HP in `GameResponseReceiver`.


The supplied client's `net/godfield/game/PowerType.as` defines a common
`MAX = 99` for HP, MP, and YEN (the browser client's CP). Production code already
uses the shared `MAX_STAT` constant for resource clamping, exchange validation,
and the Venus mystery. Flash stat-bound test setup and assertions reuse that
constant; a regression test explicitly verifies that all three resource-increase
commands cap at the source-defined 99. The Pestle cap test also keeps its starting
HP and MP within legal stat limits while inspecting the prepared attack power.
