# Dogfield

Dogfield is a complete TypeScript port of the official God Field client, with a local game server.  

Playable in the browser, or with a patched Android app, it mirrors the latest version of the game.  
We also have full support for the Flash versions from 2010 and 2013+.

## Run it

```sh
npm ci
npm run server
```

Open <http://127.0.0.1:8787>. To build the browser client without starting the server, run `npm run build`.

The server listens on `0.0.0.0:8787` by default and stores data in `.local-server/state.json`. Set `HOST`, `PORT`, or `DATA_DIR` to change those defaults.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `HOST`, `PORT` | Listen address and HTTP port | `0.0.0.0`, `8787` |
| `DATA_DIR` | Server state directory | `.local-server` |
| `ASSET_DIR` | Browser client files | `public` |
| `ALLOWED_ORIGINS` | Additional allowed web origins | empty |
| `FLASH_PORT` | Flash Projector TCP port; `0` disables it | `58001` |
| `FLASH_ASSET_DIR` | Override the included Flash assets | `public/flash/assets` |
| `FLASH_RUFFLE_DIR` | Override the installed Ruffle runtime | `@ruffle-rs/ruffle` npm package |
| `FLASH_STARTING_CREDITS` | Starting Flash account credits | `1000` |
| `CHROMIUM_PATH` | Chromium executable for browser checks | `/usr/bin/chromium` |
| `REFACTOR_ROOT` | Optional log corpus for bot verification | `../godfield-refactor` |
| `FFDEC_JAR` | JPEXS jar for rebuilding Flash clients | unset |

## Play other clients

The patched Android app is built from the God Field 1.5.32 XAPK in `original/apk/`:

```sh
npm run apk:setup
npm run apk:patch
adb install public/apk/God-Field-1.5.32-modded.apk
```

The app uses the official server by default. To use Dogfield, enter its address under **Server** and tap **Connect**. See [Android setup](docs/APK.md).

Flash clients are served at `/flash/`:

- 2013+: <http://127.0.0.1:8787/flash/>
- May 2010: <http://127.0.0.1:8787/flash/?version=201005>
- August 2010: <http://127.0.0.1:8787/flash/?version=201008>

The browser launcher serves the bundled Ruffle runtime. Flash Projector uses the configured TCP port. See [Flash setup and URL options](docs/FLASH.md).

Flash images and sounds are included under `public/flash/assets`; no asset import is needed to run the server. [Asset sources and replacements](docs/FLASH-ASSETS.md) lists the 2010 artwork replacements, sound substitutions, and generated interface images.

## Checks

```sh
npm run typecheck
npm test
```

Optional browser, Flash, APK, and oracle checks:

```sh
npm run test:browser
npm run test:flash:browser
npm run test:flash:parity
npm run test:apk
npm run verify:logs -- --oracle --report=/tmp/dogfield-oracle.json
npm run verify:bot -- --report=/tmp/dogfield-bot.json
```

Oracle and bot verification use recorded logs when available. `REFACTOR_ROOT` selects an additional log corpus. See [verification notes](docs/ARCHITECTURE.md#checks).

## Behavior and project structure

The HTML5 client follows the official client. Server behavior is tested locally and compared with recorded official transitions where those records are available. Bot decision-making and undocumented random or timeout behavior are approximate. Bot names and Duel rating updates are strongly supported. [Behavior accuracy](docs/BEHAVIOR.md) summarizes the evidence and known gaps.

`src/` contains the browser client and shared game rules. `server/` contains the local server, persistence, rooms, bots, and Flash support. `public/` contains client assets, including patched Flash movies. `tools/` contains client-patching and verification utilities; `tests/` and `server/tests/` contain automated checks.

## Documentation

- [Architecture, server API, and checks](docs/ARCHITECTURE.md)
- [Behavior confidence and open questions](docs/BEHAVIOR.md)
- [Android app build and connection](docs/APK.md)
- [Flash clients, assets, and URL options](docs/FLASH.md)
- [Live-service research tools](tools/live-games/README.md)
- [Bot-training project](ai/README.md)
