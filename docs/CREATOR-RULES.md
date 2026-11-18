# Creator clarification and recorded-game audit

On November 18, 2026, the user supplied the creator's Japanese Twitter response.
The response text is the source of the rules below; a tweet URL was not supplied.
The audit reopens existing official-service source logs in the sibling
`godfield-refactor` checkout. It makes no live requests.

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
The existing acceptance table matches all 4,248 recorded confirmations in the
bot verifier. The server now returns the table's decision directly.

The creator also confirms that attack targeting partitions all players into
upper and lower strength groups and attacks the opposite group. Group sizes
need not match. A singleton group attracts concentrated attacks. Strength
combines statuses, with HP carrying greater weight. Card/defense selection
probabilities and the exact strength calculation remain private.

The local targeting policy is **still an approximation**. It now uses the
actor and every living player's HP, MP, and currency, rather than enemy HP rank
alone. Its estimated strength is `HP + MP/2 + currency/3`, split at the living
players' mean. Opposite estimated groups receive a weight multiplier of 3 on
top of the existing empirical target distribution. These coefficients, the
mean boundary, and the soft multiplier are local estimates, not official
rules. Targets within the same estimated group remain possible because the
true score and boundary are unknown. Buy, Sell, Tear, Fog, and Confusion retain
their separately observed targeting paths.

The scoring candidates were explored on training games. Validation games are
held out by SHA-256 game ID, using the bot verifier's existing 20% split.
MP is reconstructed from the original events, including attack/defense costs,
Exchange, and MP changes. Updates are retained only when the reconstructed
final MP matches every player in the authoritative next snapshot. This excludes
1,587 of 15,521 updates; 13,934 updates produce 70,264 enriched decisions. End
state agreement is a consistency check, not proof of every intermediate value.

On 4,074 eligible held-out targeting decisions with reconstructed MP, average
negative log likelihood improves from **1.89065 to 1.77277** (lower is better).
This supports the added status/group preference; it does not establish exact
parity with the private targeting algorithm. Simple hard group replacements
were also investigated and predicted the recordings less accurately.

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
