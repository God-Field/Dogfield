# Live-service research tools

These scripts connect to the official God Field service to run games or inspect protocol behavior. They are separate from `npm test`, which uses only local fixtures. Live runs write JSONL records under `logs/live/` by default; that log directory is not included in this repository.

## Run a training game

```sh
node tools/live-games/play-game.mjs --players 2 --log logs/live/one.jsonl
```

Run several games with varying player counts:

```sh
node tools/live-games/run-parallel.mjs \
  --games 4 --concurrency 4 --players-list 2,3,4,5 \
  --seconds 120 --coverage logs/live/coverage.json
```

The scripts use the shared engine to decode state and validate commands. `play-game.mjs --help` and `run-parallel.mjs --help` list the current options. Other scripts under this directory run protocol, Duel, player-count, disconnect, and Dream probes; invoke each with `--help` where supported.

`analyze.mjs` and the other analyzers read saved logs without contacting the service. The oracle and bot verifiers are documented in [Architecture](../../docs/ARCHITECTURE.md#checks).
