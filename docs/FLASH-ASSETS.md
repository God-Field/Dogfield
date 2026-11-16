# Flash asset sources

Runtime images and sounds are checked in under `public/flash/assets`. The server does not need `.local-flash`, a sibling checkout, Python, or an asset ZIP at runtime. Ruffle comes from the npm dependency.

## Historical base files

781 images, 46 MP3 sounds, and `crossdomain.xml` were copied unchanged from the `godfield-flash` repository’s `client-files/static.godfield.net` backup (source commit `fcc83740a3d3cd9968e6e5cd2b7ed781f53abe80`). Original client artwork is credited to Guuji and Itou Ami; the original client credits sound materials to The Match-Makers.

The SWFs load these files externally. They were not extracted from the SWFs. No image from the old `/tmp/archive/game/files/gf_image` collection is included.

## 2010 card artwork

The source priority is the matching 2013 Flash card image, followed by a reviewed matching HTML5 card image. Filename paths requested by the SWFs remain unchanged. HTML5 WebP images are converted to PNG at their existing 80×80 size, without resizing. The mappings are in `tools/flash/image-aliases.json` and `tools/flash/html5-image-aliases.json`.

### Ogre set review

The embedded Japanese names change from `剛鬼` (`gouki`) in both 2010 versions to `鬼` (`oni`) in 2013. Neither catalog contains both sets. All four English names, protector categories, attack bonuses, prices, and `INCREASE_ATK`/`DFS` effects correspond. Shoes and armor retain the same defense; helm and gauntlet defense change as shown below. This supports correspondence between the four cards rather than two coexisting sets. The 2013 drawings are replacement artwork; the tables do not establish that the 2010 drawings were identical.

| Piece | 2010 ID / Japanese name | 2013 ID / Japanese name | Defense, 2010 → 2013 | Attack bonus | Price |
| --- | --- | --- | --- | --- | --- |
| Shoes | 207 / 剛鬼のくつ | 133 / 鬼のくつ | 3 → 3 | +5 | 10 |
| Helm | 241 / 剛鬼のかぶと | 160 / 鬼のかぶと | 6 → 7 | +10 | 15 |
| Gauntlet | 242 / 剛鬼の小手 | 146 / 鬼の小手 | 6 → 5 | +10 | 15 |
| Armor | 272 / 剛鬼のよろい | 170 / 鬼のよろい | 9 → 9 | +15 | 20 |

### Replacement file list

Destinations below are relative to `public/flash/assets/images/card/`. Flash sources are relative to that same directory; HTML5 sources are relative to `public/images/items/`.

| Destination | Source | Version |
| --- | --- | --- |
| `weapon/muchi.png` | `weapons/whip.webp` | html5 |
| `weapon/nokobunbun.png` | `weapons/saw-boom-boom.webp` | html5 |
| `weapon/jet_yo-yo.png` | `weapons/jet-yo-yo.webp` | html5 |
| `weapon/naginata_classic.png` | `weapons/naginata-classic.webp` | html5 |
| `weapon/final_kiba.png` | `weapons/final-tusk.webp` | html5 |
| `weapon/gravity_mace.png` | `weapons/gravity-mace.webp` | html5 |
| `weapon/moro_bukkomi_axe.png` | `weapons/direct-smash-axe.webp` | html5 |
| `weapon/angel_knife.png` | `weapons/angel-knife.webp` | html5 |
| `weapon/angel_axe.png` | `weapons/angel-axe.webp` | html5 |
| `weapon/bokutou.png` | `weapons/wooden-sword.webp` | html5 |
| `protector/kawa_no_boushi.png` | `armor/leather-cap.webp` | html5 |
| `protector/gouki_no_kutsu.png` | `protector/oni_no_kutsu.png` | flash-2013 |
| `protector/gouki_no_kabuto.png` | `protector/oni_no_kabuto.png` | flash-2013 |
| `protector/gouki_no_kote.png` | `protector/oni_no_kote.png` | flash-2013 |
| `protector/hagane_no_tate.png` | `armor/steel-shield.webp` | html5 |
| `protector/hagane_no_yoroi.png` | `armor/steel-armor.webp` | html5 |
| `protector/hagane_no_kabuto.png` | `armor/steel-helm.webp` | html5 |
| `protector/energy_helm.png` | `armor/energy-helm.webp` | html5 |
| `protector/energy_armor.png` | `armor/energy-armor.webp` | html5 |
| `protector/gouki_no_yoroi.png` | `protector/oni_no_yoroi.png` | flash-2013 |
| `protector/core_barrier.png` | `armor/core-barrier.webp` | html5 |
| `protector/core_protector.png` | `armor/core-protector.webp` | html5 |
| `protector/angel_no_kote.png` | `armor/angel-gauntlet.webp` | html5 |
| `creature/koakuma.png` | `devils/small-devil.webp` | html5 |
| `creature/chuuakuma.png` | `devils/medium-devil.webp` | html5 |
| `creature/daiakuma.png` | `devils/large-devil.webp` | html5 |
| `creature/itazuraman.png` | `devils/trickster.webp` | html5 |

92 unique active 2010 card images remain unavailable. The patched 2010 clients tolerate missing card images.

## Copied original sounds

These 46 files were copied unchanged from `godfield-flash/client-files/static.godfield.net/sounds/` into `public/flash/assets/sounds/`:

```text
alert.mp3
assistant.mp3
assistant_add.mp3
assistant_remove.mp3
block.mp3
book_tab_down.mp3
book_tab_over.mp3
button_down.mp3
button_over.mp3
card.mp3
client_turn.mp3
counter.mp3
damage.mp3
damage_dark.mp3
dead.mp3
defense_harm.mp3
disease.mp3
dying_attack.mp3
entry_toggle_over.mp3
exchange.mp3
flick.mp3
game_draw.mp3
game_start.mp3
game_start_number.mp3
game_win.mp3
harm_add.mp3
harm_remove.mp3
hit.mp3
hp_increase.mp3
illusion_item.mp3
item_remove.mp3
miss.mp3
mortar.mp3
mp_increase.mp3
mystery.mp3
no_change.mp3
open_cover.mp3
reflect.mp3
revive.mp3
seizure.mp3
target.mp3
toggle_down.mp3
winner.mp3
worse.mp3
yen_absorb.mp3
yen_increase.mp3
```

## Sound substitutions

These ten additional filenames are copies of the included sounds listed below. They are functional substitutions, not recovered originals or verified filename renames. `tools/flash/recover-sounds.py` regenerates them.

| Requested filename | Copied sound | Purpose |
| --- | --- | --- |
| `entry_over.mp3` | `button_over.mp3` | Entry-button hover uses the available generic button-hover effect. |
| `entry_down.mp3` | `button_down.mp3` | Entry-button clicks use the available generic button-click effect. |
| `entry_toggle_down.mp3` | `toggle_down.mp3` | Entry selection uses the available generic toggle-click effect. |
| `bonus.mp3` | `yen_increase.mp3` | Currency bonuses use the available currency-increase effect. |
| `score.mp3` | `winner.mp3` | End-game score presentation uses the available winner effect. |
| `yen_scatter.mp3` | `yen_increase.mp3` | Distributed currency gains use the available currency-increase effect. |
| `devil.mp3` | `damage.mp3` | Damaging creatures use the available damage effect. |
| `itazuraman.mp3` | `item_remove.mp3` | Artifact or miracle removal by Trickman uses the available removal effect. |
| `megumi_san.mp3` | `hp_increase.mp3` | Helpful creatures use an available recovery effect, including MP/currency variants. |
| `illusion.mp3` | `illusion_item.mp3` | Random-action Illusion uses the available related Illusion-item effect; these are different gameplay effects. |

## Generated interface images

These interface images are generated by `tools/flash/create-mode-images.py` using Pillow. They are replacement panels, labels, and buttons, not recovered historical designs. Paths below are relative to `public/flash/assets/images/`.

The English and Japanese Duel/Spirit entry buttons reuse the original emerald login-button skin, including its angled ends, bevels, transparency, and three interaction states. Duel Records and Lottery buttons reuse the original gold logout-button skin. The English Artifact Book entrance button retains the original Japanese rectangular 300x80 skin. The Artifact Book draw button likewise retains its original rectangular 300x120 skin, bevels, gradient, and disabled palette. Lettering inside the Artifact Book menu stays fixed across interaction states, matching the Japanese controls. The entrance Artifact Book button moves its lettering down two pixels when pressed. Labels use Liberation Serif for English and Noto Serif CJK for Japanese. The generator rebuilds these buttons each time; other replacement panels are created only when missing. The lettering uses a lit upper-left bevel, a darker lower-right bevel, and a soft shadow to reproduce the original raised effect. The face and bevel colors are sampled from the original PNGs, including the brighter hover and darker pressed palettes:

| Text face | Up | Hover | Pressed |
| --- | --- | --- | --- |
| Emerald button | `#ddffdd` | `#ffffff` | `#abcdab` |
| Gold button | `#4f4f4f` | `#818181` | `#1d1d1d` |

The gold lettering’s base bevel colors are `#717171` and `#373737`; emerald lettering uses white and `#abcdab`. Hover adds 50 to each color channel and pressed subtracts 50, clamped to the valid range, matching the original state palettes.

Label placement uses the visible lettering bounds measured from the original English/Japanese login and logout buttons, rather than centering the font’s line box. Horizontal centers are scaled with the button dimensions. Enter labels are vertically centered in their buttons; gold-button labels retain the measured vertical centers. Pressed labels move down by the original two-pixel offset (scaled with height), with no horizontal movement; hover retains the normal alignment.

```text
component/charin/charge_help.png
component/charin/update_button_down.png
component/charin/update_button_over.png
component/charin/update_button_up.png
component/coin/charge_help.png
component/coin/duel_ticket.png
component/coin/god_coin.png
component/duel/background.jpg
component/duel/bonus.png
component/duel/close_button_down.png
component/duel/close_button_over.png
component/duel/close_button_up.png
component/duel/result.png
component/duel/score_bonus_help.png
component/duel/straight_help.png
component/offline/entrance/lottery.png
component/spirit/background.jpg
component/spirit/bonus.png
component/spirit/mode.png
component_en/duel/entry_button_down.png
component_en/duel/entry_button_over.png
component_en/duel/entry_button_up.png
component_en/duel/result_button_down.png
component_en/duel/result_button_over.png
component_en/duel/result_button_up.png
component_en/offline/entrance/book_button_down.png
component_en/offline/entrance/book_button_over.png
component_en/offline/entrance/book_button_up.png
component_en/offline/entrance/lottery_button_down.png
component_en/offline/entrance/lottery_button_over.png
component_en/offline/entrance/lottery_button_up.png
component_en/spirit/entry_button_down.png
component_en/spirit/entry_button_over.png
component_en/spirit/entry_button_up.png
component_ja/duel/entry_button_down.png
component_ja/duel/entry_button_over.png
component_ja/duel/entry_button_up.png
component_ja/duel/result_button_down.png
component_ja/duel/result_button_over.png
component_ja/duel/result_button_up.png
component_ja/offline/entrance/lottery_button_down.png
component_ja/offline/entrance/lottery_button_over.png
component_ja/offline/entrance/lottery_button_up.png
component_ja/spirit/entry_button_down.png
component_ja/spirit/entry_button_over.png
component_ja/spirit/entry_button_up.png
```

The English encyclopedia includes generated skins for all ten category tabs
(`component_en/offline/book/tab/{0..9}_{up,over,down,selected_disabled}.png`)
and its draw button (`component_en/offline/book/element_add_button_{up,over,down,disabled}.png`).
The tabs preserve the original silhouettes and state palettes, with English
labels rendered over locally restored areas of the original tab texture. The draw button
shows its cost of 10 beads, matching the client's English currency label.
Shared encyclopedia backgrounds and page grids contain no Japanese text.

A complete inventory of locally invented and adapted image resources, including
legacy compatibility images, is in [FLASH-GENERATED-IMAGES.md](FLASH-GENERATED-IMAGES.md).

## Maintenance

Normal server startup needs only `npm ci` and `npm run server`. To reimport from a local historical backup and rebuild the replacements (requires Python Pillow):

```sh
npm run flash:setup -- --source=/path/to/godfield-flash/client-files
```

To regenerate replacements from the already included base assets:

```sh
python3 tools/flash/recover-images.py
python3 tools/flash/recover-sounds.py
python3 tools/flash/create-mode-images.py
```

The image recovery tool accepts only reviewed 2013 and HTML5 mappings. It does not search the old `gf_image` archive. The standalone packaging tool reads the checked-in public assets and the installed npm Ruffle distribution:

```sh
python3 tools/flash/bundle.py --with-ruffle
```


### Legacy protocol UI compatibility

The generator also supplies 2010 room-filter checkboxes, the paid-room toggle,
compact English/Japanese top-bar encyclopedia buttons, and draw controls labeled
with the legacy five-point cost. These are functional replacements using the same
included button skins; they are not recovered historical artwork.

The server reuses matching `offline/book/` panels, page backgrounds and remaining
controls at the legacy `freefight/book/` URLs when no original file is present.
The existing 300×200 bonus panel is also served at the legacy login-bonus and
Free Fight bonus URLs. All original paths continue to work. Item descriptions
come from the 2010 embedded CSVs; the layouts and costs come from the 2010 classes.
