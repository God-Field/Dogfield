# Creator clarification and recorded-game audit

The user supplied the creator's Japanese [November 16, 2026 Q&A](https://xitter.cf/guuji/status/2122216171479162941).
The audit replays existing official-service logs from the sibling
`dogfield` and `godfield-refactor` checkouts.

## Confirmed rules and implementation

### Earth guardian

Earth chooses one card uniformly from obtainable trade, weapon, armor, and
sundry cards. It uses a directly usable card, or uses **もらす** (Drop) to give
that same selected card. There is no separate Drop percentage roll and no
second gift draw after selecting the Drop branch.

The current catalog has 207 eligible cards: 125 directly usable cards and 82
Drop cards. Consequently, Drop is **82/207 = 39.6135%**, conditional on Earth
acting. Discard and Sacrifice are commands with zero gift rate and are excluded;
all positive gift rates have equal weight in this draw. The statement refers
to a uniform card draw, rather than four equally likely categories.

Earth's conjured Sell partner distribution is not specified by the clarification.
Its existing gift-rate-weighted selection remains an approximation.

### Moon guardian

Moon chooses uniformly from all miracles except **＜壁＞** (Wall) and
**＜乱気流＞** (Turbulence). It uses **満月刀** (Full Moon Blade) alongside
**＜オーラ＞** (Aura) or **＜蜃気楼＞** (Mirage), whenever either is drawn.
The current pool contains 28 cards, making the combination rate
**2/28 = 7.1429%**. Eligibility uses gameplay category and ability fields.
Artwork names do not determine eligibility.

### Inventory overflow

Every occupied slot is equally eligible, including performed miracles. The
same rule applies to Earth Buy and Drop, mixed hands, and hands consisting
entirely of performed miracles. Pending refill placeholders are not cards.
The acquisition method no longer has an option to protect performed miracles.

### Bot purchases and targeting

The creator confirms that purchase acceptance is fixed by card, with no roll.
The server returns the table's decision directly. The verifier matches
all 5,346 eligible recorded choices in Dogfield and 4,245 in Godfield
Refactor. With `--buy-decisions`, the replay and verifier share the
buyer's balance just before `setBought`. This confirms affordability
for 5,227 and 4,118 choices respectively. Successful transactions also
prove affordability. Of the declines without a replayed balance, six
were excluded by the legacy affordability check. The remaining 18
were included using that legacy check. Unaffordable offers that stop
at `canNotBuy` have no recorded Buy choice.

The creator also confirms that attack targeting partitions all players into
upper and lower strength groups and attacks the opposite group. Group sizes
need not match. A singleton group attracts concentrated attacks. Strength
combines statuses, with HP carrying greater weight. Card/defense selection
probabilities and the exact strength calculation remain private.

The local targeting policy is **still an approximation**. It scores every
living player using `3 × HP + 2 × MP + currency`, with 90 extra points
for a player with a guardian. A bot above the lobby
mean aims at players weaker than itself. A bot below the mean aims at
players stronger than itself. That gives each attacker its own cutoff.
With three living players, only an attacker at the highest strength
aims down. Other attackers aim up from their own score.
At the mean, it can target stronger or tied enemies. If all strengths
tie or its preferred side has no legal enemy, the bot chooses uniformly
from legal enemies. Buy, Sell, Tear, Fog, and
Confusion retain their separately observed targeting paths.

The verifier reports the original shared mean cutoff as `boundary`
and the current rule as `actorRelativeBoundary`. On held-out direct
combat attacks, the current rule matched 4,685 of 5,388 Dogfield
decisions (86.95%) and 2,988 of 3,433 Godfield Refactor decisions
(87.04%), excluding exact score and attacker-mean ties. The shared and
attacker-relative cutoffs have slightly different tie counts. In
held-out plain weapon attacks where the attacker was at least 30
strength points from the mean, the new rule matched 714 of 721 in
Dogfield and 402 of 415 in Godfield Refactor. That leaves mismatches
even well away from the estimated boundary.

The verifier now breaks these results down by the attacker's distance
from the mean and records the five farthest mismatches. In the stricter
direct-attack slice, the rule matched 344 of 344 decisions at a distance
of at least 60 strength points, and 1,531 of 1,569 at distances from
30 to below 60. These counts describe the sampled games. They do not
establish that the official bot has a random band or uses those cutoffs.

Changing linear HP, MP, and currency weights alone cannot reconcile
this rule. On the plain weapon held-out split, 27 Dogfield rows and
31 Godfield Refactor rows disagree for every positive linear weighting
where HP has at least as much weight as either other stat. This follows
by checking the four corners of the normalized MP and currency weight
range. For example, `account-078-game-19-parallel-1`, update 7, events
6–7, records a bot with 40 HP, 25 MP, and 20 currency choosing a
target with 45 HP, 25 MP, and 20 currency. The bot is above the
lobby mean with all four weight combinations, but chooses the stronger
player. The raw events record a direct attack and target selection.

A separate Dogfield probe compared previous snapshots and added hand
size, guardians, curses, confusion, human player status, attack power,
and turn number. On 3,030 held-out attacks with those inputs available,
the current rule scored 88.45%. A previous-snapshot score fell to 81.02%,
and a model fitted with the additional inputs scored 88.25%. This
probe used preceding snapshot values for non-stat player inputs.

Nonlinear transformations of HP, MP, and currency did not improve the
attacker-relative rule on both corpora. A separate sweep also tested
reducing the influence of unusually weak or strong opponents on the
direction decision. It produced no improvement across both held-out
sets. This matches a stronger limitation seen directly in the logs.

In Dogfield's `account-052-game-03-attempt-3.jsonl.gz`, update 4, the
29 HP bot (player 4) attacks the 34 HP bot at events 54–55. The 26 HP
bot (player 5) attacks the 3 HP bot at events 59–60. All four have
10 MP and 20 currency. Between the decisions, the first attack is
blocked and the next turn begins, with no HP, MP, currency, curse, or
guardian change. Thus any score increasing with HP must rank player 4
above player 5, but the observed directions require a shared cutoff
above player 4 and below player 5 at the same time. The four actors
and targets have distinct stats within these pairings. The choice
can still depend on changing hands, the selected attack, another
input, or random assignment. The verifier's `directionConflicts`
report finds such opposing choices in identical reconstructed stat
snapshots within a single update.
It found one pair in each corpus. The Godfield Refactor example is
`live/run-botpol-wave3/run-20261110-170946-xykh-g45.jsonl.gz`,
update 6, events 3 and 10. A curse changes between those choices, so
the Dogfield pair is the cleaner witness.

An additional repeat-state search keyed the complete living stat roster
and attacker stats, then required each direction to hold for every
HP-heavy linear weighting. Neither corpus contained an attacker observed
aiming in both directions at the same stat state under that criterion.
This leaves the random-direction hypothesis untested against controlled
repeats.

Hand contents from the preceding raw snapshot provided little additional
predictive value. A model trained on Dogfield that included available
attack, defense, and healing cards improved held-out direction agreement
from 90.20% to 90.30% on Dogfield and from 89.65% to 89.79% on Godfield
Refactor, compared with the same model trained on stats alone. Earlier
attacks between the same players also failed to improve held-out
agreement when included as a strength adjustment. That history check
used the logged plain weapon subset, so unobserved attacks could not
contribute to it.

A check on player seat, lobby size, turn, and match phase yielded
90.10% held-out agreement in Dogfield and 89.66% in Godfield Refactor,
compared with 89.63% and 89.61% for the same fitted model using only
stats. Bot names had little usable recurrence. Fewer than 9% of held-out
attacks in either corpus involved a name that appeared during training.

The verifier also reports the gap between attacker and target strength
as `byTargetMargin`. The current direction rule missed 238 of 598
held-out direct attacks with gaps of 1–6 points across the two corpora.
It still missed 50 of 2,631 attacks separated by more than 60 points.
A fitted variant allowing a small overlap between the sides reached
93.52% and 93.48% on held-out plain weapon attacks. That rule can accept
a stronger target when aiming down or a weaker target when aiming up,
so its score does not verify a hard partition. The overlap was not
added to the bot.

Ranking players separately by HP, MP, and currency and combining those
ranks yielded 82.41% and 80.20% held-out plain weapon agreement. Per-stat
normalization by lobby spread yielded 87.47% and 87.53%. On the same
rows, the existing score gave 88.68% and 88.99%. Fitting a combination
of these features did not improve the result.

The verifier's `sharedCutoffDisplacement` counts how far a shared mean
cutoff would need to move to separate the logged actor and target.
This is a lower bound and treats either endpoint as zero distance
when it coincides with the mean. A shift of over 30 strength points
would be needed for 44 of 5,402 held-out Dogfield direct attacks and
29 of 3,437 Godfield Refactor attacks with distinct scores. A model
that sampled a hard cutoff around the mean and chose uniformly within
the opposite group scored 1.277 and 1.634 mean negative log likelihood
on eligible plain weapon rows. Drawing a cutoff uniformly gave 1.289
and 1.632. Allowing the sampled cutoff's distribution to depend on the
attacker reduced those losses to 1.255 and 1.597. The sampling model
gives every gap some probability by construction and cannot identify
which cutoffs are genuinely random in the official bot.

The MP replay now reads the pending attack from the recorded snapshot's
`attack` field and tracks the recipient of a `hit` event. This retained
283 more updates and 3,702 more reconstructed decisions across the two
corpora. The reconstruction also records whether the very next raw event
after `useAttackItems` selects the same target. All 5,625 Dogfield and
3,591 Godfield Refactor held-out direct choices checked by the verifier
had that immediate matching event. This does not support the hypothesis
that a later guardian or effect was being counted as the bot's choice.
After applying the stricter direct combat, confusion, fog, and replay
filters, the attacker-relative rule still missed 684 of 5,300 non-tie
decisions in Dogfield and 426 of 3,386 in Godfield Refactor.

The next reconstruction pass replays HP, MP, currency, and deaths
together, including resource overflow into other stats, transactions,
and damage. It retains full decision snapshots only when those fields
agree with the authoritative end of the update for every player. This
check passed for 33,467 of 33,607 Dogfield updates and 15,365 of 15,521
Godfield Refactor updates. Within confirmed updates, the replay
reconstructed a different HP, currency, or living status from the
original scanner in 41,566 Dogfield and 46,909 Godfield Refactor rows
across all decision types.

The verifier's `fullStatReplayBoundary` uses the replayed roster
without the legacy forward/backward rank test. It reports single-enemy
decisions separately. The current rule matched 5,150 of 5,898 non-tie
choices in held-out Dogfield games and 3,446 of 3,937 in Godfield
Refactor. Both previously reported same-update direction conflicts
also survive the full stat replay. Refitting the direction weights on
the corrected plain weapon data yielded no held-out Dogfield gain and
less than 0.04 percentage points in Godfield Refactor.

Decision-time curse and guardian replay passed the end-of-update check
for 33,457 Dogfield and 15,347 Godfield Refactor updates. On the held-out
plain weapon rows with confirmed status, adding 90 strength points
for a guardian raised agreement from 88.24% to 91.37% in Dogfield and
from 88.32% to 92.46% in Godfield Refactor. A later curse-weight sweep
found a repeatable held-out gain in both corpora: subtract 20 points
for each disease curse (cold, fever, hell, Heaven), and an additional
60 for Heaven. The verifier's `guardianBoundary` remains a guardian-only
comparison; the runtime replay includes both guardian and curse scores.

Separate guardian values, separate scores for direction and eligibility,
and interactions between guardians and combat stats did not improve
held-out agreement in both corpora. On the plain weapon sample that
distinguishes guardian types, the common bonus matched 91.47% in
Dogfield and 92.60% in Godfield Refactor. Fitting separate values gave
91.33% and 91.74%. In the broader status-confirmed direct attack audit,
786 of the 975 remaining mismatches had no guardian anywhere in the
living roster. The `guardianBoundary.byPairStatus` report records
where guardians were present for each outcome.

A hand reconstruction probe extended the existing reverse episode
extractor to collect the whole living roster's hands. It retained
7,198 of 18,116 Dogfield plain weapon decisions and 4,473 of 15,075
Godfield Refactor decisions where every living hand reconciled. Bot
refills are not individually logged, so endpoint reconciliation
does not establish a unique intermediate hand. Adding available
attack, armor, and healing values did not improve held-out agreement
across both corpora, including in guardian-free games.

The `guardianBoundary.byAttackItemCount` breakdown shows that attacks
using multiple items disagree more often than single-item attacks.
In the status-confirmed validation slice, single-item attacks
accounted for 783 mismatches in 8,858 non-tie choices. Attacks with
two or more items accounted for 192 mismatches in 993 non-tie choices.
Fitting adjustments for attack item count and printed weapon power
did not improve direction prediction across both held-out corpora.

Including defeated players in the mean degraded held-out agreement.
Among plain weapon attacks after at least one defeat, the living-only
mean matched 92.68% in Dogfield and 91.96% in Godfield Refactor.
Including the defeated players' remaining stats reduced agreement
to 74.09% and 75.97%. A median, trimmed mean, and midpoint also
scored worse than the living mean after adding the guardian bonus.
The verifier provides the current rule's breakdown by eliminated
roster size in `guardianBoundary.byDefeatedCount`.

A separate audit of Dogfield's team-room coordinator logs found
150 clear direct combat choices with at least two legal enemies.
The all-living mean put the target on the preferred side in 111
cases and on the other side in 34 cases. Four choices had no legal
enemy on the preferred side, and one attacker was at the mean.
The official bot chose a legal enemy in all four fallback cases.
Using the enemy team's mean gave 116 matches and 30 misses, with
four ties. This small sample does not establish a team-specific rule.

The room-by-room comparison found five choices that directly
distinguished those two means. The enemy-team mean explained four
of them in four different rooms, and the all-living mean explained
one. Both missed 28 of the same choices. The live team cutoff stayed
unchanged.

The replay now verifies positive confusion counters against the
end-of-update snapshots. This passed in 33,460 Dogfield and 15,361
Godfield Refactor updates. In the held-out direct target provenance
sample, the replay agreed with the existing attacker confusion
classification in all 11,010 comparable choices. The stricter check
left the 975 remaining non-tie mismatches unchanged. There were only
two held-out plain weapon choices with a confused player elsewhere
in the roster, so the logs do not establish a score adjustment for
confusion in opponents.

Discretizing each stat or the total score into tiers did not improve
held-out agreement. For instance, rounding the score down to
multiples of 15 reduced Dogfield plain weapon misses from 271 to 208
but increased ties from 38 to 385. When ties were given half credit,
the unrounded rule remained the strongest candidate in the sweep.

The verifier now distinguishes all-player ties, attacker-at-mean
cases, and equal actor and target scores. Among the 43 held-out direct
attacks with the attacker at the mean in an unequal roster, 19
targeted a stronger enemy, 21 targeted a tied enemy, and 3 targeted a
weaker enemy. The local rule now accepts stronger and tied enemies
at the mean. The three weaker targets are still unexplained under
that rule. Fully tied rosters still use a uniform draw.

Away from the mean, the live bot makes one boundary draw when a legal
enemy has identical HP, MP, currency, and guardian. In 40% of those
draws, those enemies join the eligible group. Enemies tied only by the
estimated score retain the strict boundary. In held-out direct attacks,
official bots selected an identical-stat enemy in 127 of 551 Dogfield
opportunities and 64 of 592 in Godfield Refactor. The local draw predicts
about 94 such choices in each corpus. It recovers those ties as possible
choices, though the separate frequencies show the rate is approximate.
The verifier exposes this comparison in
`guardianBoundary.exactTieCandidates`.

For equal-strength opponents with different underlying stats, a
training sweep of lexicographic tie rules explained only 14 of 21
held-out plain weapon choices in Dogfield and 6 of 11 in Godfield
Refactor, even with a guardian-based secondary sort. No stat-priority
tie rule from that sweep was added to the bot.

The verifier's `statusPartitionConflicts` check tests whether a fixed
two-group assignment can satisfy every observed attack from an identical
full stat and status snapshot in the same game. It excludes attacks
between players with identical combat stats and guardian. The all-game
audit found one impossible snapshot among 1,142 with more than one
distinct attack pair in Dogfield, and none among 971 in Godfield
Refactor.

The Dogfield witness is `account-048-game-12-attempt-12.jsonl.gz`.
Player 6 attacks 9 at update 21 event 47, player 7 attacks 6 at update
21 event 52, and player 9 attacks 7 at update 23 event 3. All three
weapon commands have immediate target events. The two earlier attacks
are blocked and the intervening Buy is declined. Across the choices,
the living roster, HP, MP, currency, guardians, curses, and confusion
are unchanged. Players 6, 7, and 9 have distinct stats and strength
scores. With three edges connecting those three players, any fixed
two-group assignment leaves at least one logged pair in the same
group. The hands and turn position differ across choices,
so the witness leaves open grouping rules that depend on those
inputs, the attacker, or a random draw.

The verifier's `runtimeTargetSupport` checks whether the live policy
assigns any chance to the recorded opponent, including a possible
exact tie draw or legal fallback. The previous rule supported 6,047
of 6,718 held-out Dogfield choices and 3,758 of 4,123 Godfield Refactor
choices. With the three-player direction rule, this rose to 6,165
and 3,769, respectively. Three-player choices account for 774 of
791 supported in Dogfield and 89 of 94 in Godfield Refactor. For
comparison, a shared split with only the strongest in the upper group
supported 707 and 81 of those choices, respectively. That split
prevented a weakest attacker from choosing the middle player.
The older mean-only direction counts remain in the report as a
baseline. The runtime counts include forced choices and ties, and
measure eligibility rather than the chance of drawing a given target.

The bot now chooses a direct target after finalizing the attack cards.
It scores the attacker with the MP remaining after the full attack
cost, or zero MP for `atkBy2xMP`. The projection does not change live
MP before submission. On the same held-out games, runtime eligibility
rose to 6,280 of 6,718 in Dogfield and 3,866 of 4,123 in Godfield
Refactor after adding the disease-curse penalties. That is a net gain
of 119 choices over the prior runtime rule: 10,146 of 10,841 choices
(93.59%) are supported. The remaining 695 choices are unsupported by
the current group rule. The runtime report also breaks down eligibility
by attack ability.
Re-fitting the cutoff on the larger lobbies with median, spread, and
trimmed mean terms had no held-out gain across both corpora.

Refitting HP, MP, currency, and guardian weights on the post-cost
snapshots selected the existing `3:2:1` weights and 90-point guardian
bonus on Dogfield training games. The three-player direction rule also
improved agreement in games that started with more than three players.
On held-out three-player choices with unequal attacker and target
scores, the remaining 13 direction misses all involved the middle
player attacking the weakest. Three came from consecutive turns in
one Godfield Refactor game. Rules based on the gaps to the other two
players and the weakest player's HP did not improve the training fit.

The scoring candidates were explored on training games. Validation games are
held out by SHA-256 game ID, using the bot verifier's existing 20% split.
MP is reconstructed from the original events, including attack/defense costs,
Exchange, and MP changes. Updates are retained only when the reconstructed
final MP matches every player in the authoritative next snapshot. This excludes
1,587 of 15,521 updates; 13,934 updates produce 70,264 enriched decisions. End
state agreement is a consistency check, not proof of every intermediate value.

On 4,157 held-out decisions with reconstructed MP, the original mean partition puts the
actor and recorded target on opposite sides in **77.36%** of cases. A grid
search selected `HP + 0.70 × MP + 0.35 × currency`; the simpler integer ratio
`3 × HP + 2 × MP + currency` has nearly identical held-out agreement. This
supports the score ratio and mean cutoff as the strongest current candidate,
but the remaining mismatches show that the private score or boundary rule is
not fully recovered: the hard model assigns no probability to 22.64% of these
recorded targets, producing a held-out negative log likelihood of **8.11**.
The current policy enforces its inferred cutoff for ordinary attacks.
Buy, Sell, Tear, Fog, and Confusion retain their separately observed targeting
paths.

An independent audit against the 2,000-game Dogfield training corpus matched
25,493 direct bot targeting decisions to attack episodes by game, update,
actor, and chosen target. The same `3 × HP + 2 × MP + currency` mean boundary
puts the actor and target in opposite groups for only **75.33%** of decisions
(**75.56%** on the SHA-256 held-out split of 5,090 decisions). A median-rank
split reached **75.70%** on that held-out split. Neither result recovers the
creator's boundary; roughly one quarter of logged choices still conflict with
these candidate partitions. The exact grouping rule remains unknown.

Three Dogfield logs record all three pairings at the same visible status
snapshot. Players 1, 2, and 3 each have 40 HP, 10 MP, and 20 currency, with
no teams. At update 2, player 2 attacks player 1 in
`account-091-game-10-parallel-1`, player 2 attacks player 3 in
`account-080-game-06-attempt-6`, and player 3 attacks player 1 in
`account-033-game-10-attempt-10`. Each is a recorded bot weapon attack.
No fixed partition of these visible stats and player IDs puts every pair
on opposite sides. The official decision needs an additional input at least
in this case, which is consistent with a random tie rule.

Removing boundary cases still leaves mismatches. In an exploratory Dogfield
sweep of HP-heavy integer scores and mean, median, midpoint, and starting
score thresholds, the highest agreement was 82.37% on 9,893 distinct
state and attack-pair observations remaining after excluding ties for that
candidate. For example, in `account-095-game-18-parallel-1`, update 13,
event 4, player 3 (41 HP, 20 MP, 54 currency) attacks player 2 (37 HP,
5 MP, 20 currency). Player 1 has 25 HP, 0 MP, and 0 currency. The local
mean rule places players 2 and 3 above the cutoff, with no score tie.

The bot verifier's `boundary` report counts opposite-group matches for
direct combat attacks in free-for-all games. It checks that the recorded
bot command and reconstructed target agree. It uses the first attack of
an update or requires the forward and backward HP and currency to agree.
It reports score ties and exact cutoff cases separately and includes
replay coordinates and status snapshots for mismatches.

With the verifier's game-level validation split and these filters, the
mean cutoff matched 4,236 of 5,366 non-tie attacks in Dogfield (78.94%)
and 2,752 of 3,428 in Godfield Refactor (80.28%). A nonlinear score sweep
did not improve held-out Dogfield agreement. A linear cutoff fitted to
the Dogfield plain weapon sample improved that sample's held-out score
from 81.95% to 82.35%, but fell from 82.82% to 82.65% on the equivalent
Godfield Refactor slice. The fitted cutoff was not adopted.

A same-update counterexample rules out a shared cutoff on any score that
strictly increases with HP and MP and uses only HP, MP, and currency.
In Dogfield's `account-035-game-04-attempt-4.jsonl.gz`, update 4,
player 4 attacks player 2 at events 12–13, then player 5 attacks
player 4 at events 17–18. Between those choices, player 2 blocks with
a zero-cost armor and there is no HP, MP, currency, curse, or guardian
change. The three players all have 20 currency. Player 2 has 40 HP
and 20 MP, player 4 has 40 HP and 10 MP, and player 5 has 37 HP and
10 MP. A monotone score must rank them 2 > 4 > 5. The first attack
requires the cutoff above player 4; the second requires it below
player 4. Both attacks are direct, zero-cost weapons with no random hit
rate. The attack and defense cards played between choices do change the
hands, so this example leaves open rules that incorporate hand state or
recompute membership with another input.

As a check on hand state, a Dogfield sweep added hand size to the score
for first attacks whose reconstructed stats matched the preceding raw
snapshot. The hand-size coefficient chosen on training games improved
held-out agreement from 100 to 101 of 122 non-identical-stat attacks.
That check used the preceding snapshot's hand size and therefore cannot
establish the effect of intervening hand changes or individual cards.

## Fact-check against original recordings

The guardian and overflow audit reopens 676 source logs referenced by the
existing guardian and overflow campaign manifests, resolves later `.gz`
compression, and deduplicates events by game, update, and event index. It reads
all those files successfully. It does not count copies of the same event as
independent trials.

| Claim | Recorded outcome | Prediction | Statistical check |
| --- | --- | --- | --- |
| Earth Drop | 870/2,106 = 41.31% | 82/207 = 39.61% | Two-sided binomial p = .114; Wilson 95% interval 39.23–43.43% |
| Earth uniform card selection | 2,106 draws over 207 cards | Each card 1/207 | Pearson chi-square p = .194 |
| Moon blade combination | 108/1,501 = 7.20% | 2/28 = 7.14% | Two-sided binomial p = .920; Wilson 95% interval 5.99–8.61% |
| Moon uniform miracle selection | 1,501 draws over 28 cards | Each card 1/28 | Pearson chi-square p = .997 |
| Guardian action construction | 3,607 recorded Earth/Moon actions | New server selection with recorded draws | All 3,607 item sequences match; no pool or combination mismatches |
| Bot purchases | 4,248 confirmations | Fixed card decision | Zero disagreements |

There are no observed guardian cards outside the new pools. The reported
probabilities are compatible with the recordings; large p-values do not prove
identical implementations or recover the official random generator.

The overflow source scan finds 514 unique events, including 23 that displace a
performed miracle. For nine Drop events, before/after snapshots identify the
exact full hand and differ only by the replacement. None selects a performed
miracle, but the sum of the performed-card probabilities is only 0.611 expected
selections. The probability of seeing zero across these nine trials is
**52.96%** under the creator's rule. The old claim that Drop protected performed
miracles was therefore an unsupported inference. These samples are insufficient
to verify per-slot uniformity, but they do not contradict it. Exact all-performed
Buy/Drop hands remain unobserved in this corpus; regression tests cover the
creator-confirmed behavior locally.

The new engine is also sampled for 20,000 Earth selections, 20,000 Moon
selections, and 20,000 full-hand acquisitions. Per-card/slot uniformity checks
are compatible with the specified distributions (p = .896, .140, and .098,
respectively). Exhaustive deterministic interval tests check each eligible
Earth/Moon card and every overflow slot, including performed slots.

## Replay limitations

The broad oracle replay reports 95,721 transitions, 47,309 compared transitions,
48,410 transitions stopped at unrecovered entropy, 1,232,497 structural checks,
and zero structural violations. Before and after reports both contain 4,432
field differences, with identical difference records. These are pre-existing
mismatches; the full replay is not a clean parity pass. Guardian selection
coverage is supplied by the separate 3,607-action replay above, since the broad
verifier stops at unrecovered guardian random boundaries.

## Reproduction

Run from the release checkout. `--corpus` is the checkout holding the existing
recordings and campaign manifests. Raw records and generated reports stay in
ignored local directories. Python statistical analysis requires SciPy.

```sh
node --import tsx tools/live-games/analyze-creator-rules.mjs \
  --corpus=../godfield-refactor \
  --report=artifacts/creator-rules/distributions.json
python3 tools/live-games/analyze-creator-statistics.py \
  --report artifacts/creator-rules/distributions.json \
  --output artifacts/creator-rules/statistics.json
node --import tsx tools/live-games/reconstruct-target-mp.mjs \
  --corpus=../godfield-refactor \
  --output=artifacts/creator-rules/targets.jsonl.gz
node --import tsx server/verify-bot-policy.mjs \
  --targets=artifacts/creator-rules/targets.jsonl.gz \
  --split=validation --report=artifacts/creator-rules/bots-validation.json
node --import tsx server/verify-logs.mjs --logs=../godfield-refactor/logs \
  --oracle --report=artifacts/creator-rules/replay-after.json
npm run typecheck
npm test
```

The default bot targeting corpus lacks MP. Use the enriched `--targets` corpus
to validate the status/group preference. Reports include `groupContextRows`
and decision likelihood with and without that preference on the same sample.
