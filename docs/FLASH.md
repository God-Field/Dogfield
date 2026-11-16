# Flash clients

Dogfield includes patched Flash movies for 2013, May 2010, and August 2010, with images and sounds under `public/flash/assets`. The local server supports their versioned protocols and keeps Flash matches separate from HTML5 matches. Ruffle is installed with npm dependencies. No local asset directory or import step is needed to play.

The default Flash client dates from 2013 and remained in use until early 2018.

## Open a client

Start the server with `npm run server`, then open one of these addresses:

| Client | URL |
| --- | --- |
| 2013 | `http://127.0.0.1:8787/flash/` |
| May 2010 | `http://127.0.0.1:8787/flash/?version=201005` |
| August 2010 | `http://127.0.0.1:8787/flash/?version=201008` |

The browser launcher serves Ruffle from the pinned `@ruffle-rs/ruffle` npm dependency. Set `FLASH_RUFFLE_DIR` only if you want to use a different local distribution.

Maintainers can reimport the base artwork and sounds from a historical client backup with the following command. It also regenerates the reviewed card replacements, sound substitutions, and interface images (Python Pillow is needed for this maintenance command):

```sh
npm run flash:setup -- --source=/path/to/client-files
```

The PNG/JPEG artwork and MP3 sounds are external files from the historical
`client-files/static.godfield.net` backup. They are not embedded in the SWFs.
The SWFs contain code, vector shapes, fonts, and text tables; exporting their
resources cannot reproduce the external image and sound files. The portable
`godfield-flash.zip` is generated from an existing asset import, not its source.

[Asset sources and replacements](FLASH-ASSETS.md) lists the copied sounds, generated interface images, and the reviewed 2010 artwork mappings. The older `gf_image` archive is not used.

Flash Projector does not need Ruffle. It connects to the server's XMLSocket listener on port `58001` by default. Set `FLASH_PORT=0` to disable the TCP listener; the browser WebSocket endpoint remains at `/flash/socket`.

## URL options

Add these query parameters to `/flash/`. The launcher passes the connection values to the SWF as FlashVars. When opening a SWF directly in Projector, use the same values as FlashVars.

| Parameter | Default | Purpose |
| --- | --- | --- |
| `version` | `2013` | Choose `2013`, `201005`, or `201008` |
| `language` | `en` | Choose `en` or `ja` |
| `serverURL` | Launcher origin | HTTP origin for assets and APIs |
| `serverHost` | Host from `serverURL` | XMLSocket host |
| `serverPort` | `58001` | XMLSocket port |
| `socketProxy` | Derived from `serverURL` | Browser WebSocket URL |

Examples:

```text
http://127.0.0.1:8787/flash/?language=ja
http://127.0.0.1:8787/flash/?version=201005&language=en
http://127.0.0.1:8787/flash/?version=201008&serverURL=http://192.168.1.20:8787
godfield.swf?language=en&serverURL=http://192.168.1.20:8787&serverPort=58001
```

If the launcher and server use different origins, add the launcher origin to `ALLOWED_ORIGINS`.

## Rebuild and check

Rebuilding requires a user-provided original movie, JPEXS FFDec 26.4.0, Java, and GNU `patch`. The patcher checks the input movie hash, extracts only the affected ActionScript classes, applies the checked-in unified `.as.patch` files, and imports those scripts into the original movie. Extraction and patching happen in a temporary directory that is removed on success or failure; the bundled movie is replaced only after a successful import:

```sh
FFDEC_JAR=/path/to/ffdec.jar npm run flash:patch -- --source=/path/to/godfield.swf
FFDEC_JAR=/path/to/ffdec.jar npm run flash:patch -- --source=/path/to/godfield-201005.swf
FFDEC_JAR=/path/to/ffdec.jar npm run flash:patch -- --source=/path/to/godfield-201008.swf
```

Runtime diffs live in `tools/flash/patches/` (2013), `patches-2010/` (both 2010 movies), and `patches-201008/` (August-only additions). Patch paths are relative to the extracted `scripts/` directory. Exports are normalized to LF with trailing line whitespace removed before patching; patch hunks require exact context (`--fuzz=0`). To edit a patch, extract the affected class from its original movie with the same JPEXS version, normalize it, apply the current diff, edit the result, and regenerate a unified diff with `a/` and `b/` paths. Keep exported source and intermediate SWFs in ignored local directories.

The parity probe also uses unified diffs under `tools/flash/parity/`, applied to scripts extracted from the bundled 2013 movie. The audio probe extracts its Main class from each bundled movie; its recording Sound subclass is new test code. Neither check needs original client files.

`npm run test:flash:patches` checks patch application and rejection with temporary local fixtures, without JPEXS or original client files.

The parity check requires local JPEXS and Chromium. The browser smoke test requires local Chromium:

```sh
FFDEC_JAR=/path/to/ffdec.jar npm run test:flash:audio
npm run test:flash:browser
npm run test:flash:browser -- --version=201005
npm run test:flash:browser -- --version=201008
npm run test:flash:login
npm run test:flash:login -- --version=201005
npm run test:flash:login -- --version=201008
npm run test:flash:multi-tab -- --mode=training
npm run test:flash:multi-tab -- --mode=duel
npm run test:flash:multi-tab -- --mode=spirit
```

The audio check instruments the bundled movies with a local sound probe and checks that mute and zero volume never start an effect, that audible effects receive their volume before playback starts, and that unmuting restores playback. It needs JPEXS and Chromium, and uses no original client files.

The login smoke check opens the bundled movie against a local server, rejects a duplicate Free Fight name, then checks Back and a successful retry. The 2013 client also shows its built-in duplicate-login alert; the 2010 clients have no handler for that message. It uses no external service or original client files. Pass `--sequence=error-only`, `delayed-error`, `error-enter`, `enter-error`, or `enter-delayed-error` to compare server response ordering with the existing client.

The multi-tab check uses two browser tabs with the same name and account. Training starts independent games. Duel and Spirit open a second lobby and reject concurrent game entry with `userExists` if the first tab is already playing. The original paid-mode clients keep the lobby usable without displaying an alert for that code. The second tab can go Back and enter or resume a game after the first tab closes. Use `--version=201005` or `--version=201008` to check the older clients.

Paid entry rejections report `loginRequired`, `alreadyInGame`, `userExists`, `insufficientFunds`, `invalidRequest`, `caveLocked`, or `paymentRequired` according to the cause. If a Duel opponent can no longer pay when paired, the other player receives `opponentUnavailable`. These failures refresh the view and re-enable input; they do not send `isLocked`, which displays the original maintenance warning.

The 2010 movies use a separate rules profile. They support Duel Field and Spirit Field; the historical account service, purchases, and rankings are not connected. The included movies tolerate missing 2010 card images, but some 2010 entries still have no artwork in the available asset backup.

See [Flash protocol coverage](FLASH-PROTOCOL.md) for the response/error audit, legacy room charges and book draws, and login rewards.

## Encyclopedia data

The server reads the original 2013 SWF encyclopedia CSV tables from
`server/flash/data/book/`. `BookItem.csv` defines the collection order;
`EnglishData_*` and `JapaneseData_*` supply the localized entries. These are
unchanged copies of the SWF’s embedded text data, preserving the original
columns, line endings, image filenames, and `<br />` markup. The server resolves the
collection IDs and converts display line breaks when loading the tables.

To refresh them, first export `binaryData` from the original 2013 movie using
JPEXS, then copy those exports without converting their contents:

```sh
java -jar /path/to/ffdec.jar -export binaryData /path/to/export /path/to/godfield.swf
python3 tools/flash/extract-book.py --binary-dir=/path/to/export
```

## 2010 item distributions

The 2010 server reads item and assistant attack weights from the original
2010 SWF tables in `server/flash/data/items-2010.csv` and
`server/flash/data/assistants-2010.csv`. These tables were checked against
both the May and August 2010 movies; both exports are identical. To refresh
them, export `binaryData` from either original movie, then run:

```sh
java -jar /path/to/ffdec.jar -export binaryData /path/to/export /path/to/godfield-201008.swf
npm run flash:extract-2010-data -- --binary-dir=/path/to/export
```

The extractor reads directly from an explicitly supplied original SWF and
uses a temporary directory for JPEXS exports. Provide the SWF and JPEXS jar:

```sh
FFDEC_JAR=/path/to/ffdec.jar npm run flash:extract-2010-data -- --swf=/path/to/godfield-201008.swf
```

The main draw pool has 500 total weight: Trade 60, Weapon 181, Protector 130,
Magic 30, Sundry 90, and Creature 9. Each of the eight elemental assistants
has 20 total attack weight; Earth and Moon each have one fixed-weight result.
2010 special attacks that discard, sell, or add an item require exactly two
cards, as in the original client.

## Historical rules

See [Flash rules and historical sources](FLASH-HISTORY.md) for the currency-era
profile, source dates, corrected rules, and remaining differences.
