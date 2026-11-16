# Flash rules and historical sources

The bundled 2013+ client uses the currency-based rules described by the
[January 12, 2013 mode guide](https://web.archive.org/web/20130112065718im_/http://www.godfield.net/mode/).
The later free-play overhaul announced in the
[archived news](https://web.archive.org/web/20140113184604im_/http://www.godfield.net/news/)
is outside this server's rules profile.

## Corrections from the guides

| Area | Server behavior |
| --- | --- |
| Lottery | Equal chances of 25 coins or one Duel ticket. A second ticket replaces the existing ticket without coin compensation. |
| Public Free Fight | Unequal team sizes cannot start, following the November 19, 2012 news entry. Private rooms permit unequal teams. |
| Automatic teams | Randomly choose a supported team count that divides the player count. If none divides it, use at least three teams whose sizes differ by at most one. The guide does not specify probabilities between eligible team counts; the server chooses uniformly. |
| Filtering | Filtered chat is muted. Ejection requires a strict majority of players; spectators cannot contribute votes. |
| Free Fight recovery | Reconnecting with the same prophet name restores the active game. A different name enters normally. |
| Duel | Chat is unavailable. Two accounts cannot meet again while either account's current round still records that opponent. The queue can match other eligible pairs. |
| Duel bonus | After 15 games, the next round's per-game bonus is twice the wins plus draws, with another 10 for a score of at least 16. |
| Spirit recovery | A disconnected player can resume the same game within 30 minutes without another entry charge. Expiration records a loss. Recovery requires the same local account and prophet name. |
| Spirit progression | Completing 100 games unlocks the next cave even with zero points. This achievement remains after a new 100-game block starts. |
| Encyclopedia | Only Duel and Spirit victories award banked Magatama, divided among tied winners with rounding down. Training and Free Fight do not award it. |

The archive serves different capture dates for the linked subpages:

- [Free Fight, May 7, 2013](https://web.archive.org/web/20130507133121id_/http://www.godfield.net/mode/freefight): team assignment and filtering. Public-team restrictions come from the November news entry rather than extrapolating later rules.
- [Duel, June 17, 2012](https://web.archive.org/web/20120617172010id_/http://www.godfield.net/mode/duel/): rounds, bonuses, repeat opponents, and chat.
- [Spirit, June 17, 2012](https://web.archive.org/web/20120617171725id_/http://www.godfield.net/mode/spirit/): recovery and cave progression. Its old seven- and nine-player fees are superseded by the July announcement effective August 1, 2012: 75/160 and 125/300 entry charge/base payout respectively, already used by the server.
- [Encyclopedia, March 16, 2013](https://web.archive.org/web/20130316030459id_/http://www.godfield.net/mode/book): eligible modes and Magatama rewards.

## Remaining limits

This is not a complete reproduction of the historical service. Rankings and
purchases are not connected. The client enforces its local time gauge; the server
does not yet maintain authoritative remaining-time banks. The lottery cooldown
is stored per local account on the server; the bundled client's device storage
also enforces its cooldown, but clearing that storage and changing accounts can
bypass the original device-wide restriction. Spirit bots use the local bot
policy rather than a recovered historical Spirit AI. Recovery state is held in
memory and does not survive a server restart.
