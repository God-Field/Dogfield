# Edited Godfield sounds

This subdirectory contains the likely edited versions of the effects whose game
audio does not match a single source WAV exactly.

All files are:

- mono, `22050 Hz`, `16-bit PCM`
- trimmed or padded to the exact duration of the corresponding file in
  `public/audio/`
- given a short fade-in/fade-out (`5 ms`) to avoid clicks

The matching analysis and source-file table are in `../README.md`.

## How the corrections were applied

| Strategy | Meaning |
|---|---|
| `raw` | Use the source as-is, only trim/pad to the target duration. No reliable pitch or speed correction was found. |
| `crop` | Choose the best target-length excerpt of a longer source. Used for short warning/sting sounds cut from long recordings. |
| `speed` | Time-stretch the whole source to the target duration. The applied rate is `source_duration / target_duration`; values above `1.0` speed the source up. |
| `loop` | Repeat the source with short fades at the loop boundaries until it reaches the target duration. Used when the source is much shorter than the target. |
| pitch shift | Applied after time-stretching, in semitones. Only shifts that were explicitly supported by the analysis were applied. |

For several effects the CQT search suggested very large pitch shifts (for
example ±2 octaves). Those are treated as matching artifacts and are **not**
applied, because they usually indicate that the source is a composite or that
the match is weak.

## Applied corrections

| Effect | Source | Strategy | Pitch | Speed / rate | CQT score | Note |
|---|---|---|---|---|---|---|
| `alert` | `se_old_pack00/alarm01.wav` | `crop` | 0 | — | `0.271` | Long warning source cut to the short alert sting. The exact excerpt is uncertain. |
| `attack-by-guardian` | `se_old_pack00/cursor03.wav` | `raw` | 0 | — | `0.939` | Very strong spectral match; only duration trim/pad was needed. |
| `attack-dyingly` | `se_old_pack00/voice025.wav` | `speed` | 0 | `1.313x` | `0.113` | Probable scream-based composite. The single-source correction is weak. |
| `block` | `se_old_pack00/metal48.wav` | `raw` | 0 | — | `0.911` | Strong match; the game version only adds a short tail/decay. |
| `boost-mp` | `se_old_pack00/buble00.wav` | `speed` | 0 | `0.954x` | `0.595` | Source duration is already very close. Alternative candidates: `power05`, `power06`, `power09`. |
| `confusion` | `se_old_pack00/voice029.wav` | `speed` | 0 | `0.633x` | `0.432` | Voice-like formants; likely stretched. `voice033` is an alternative. |
| `deal-dark-damage` | `se_old_pack00/noise10.wav` | `speed` | `-5` | `0.511x` | `0.520` | Harsh noise stretched to the target length and pitched down. `warp03`/`warp03r` are alternatives. |
| `devil-to-boost-something` | `se_old_pack00/power35.wav` | `speed` | 0 | `0.580x` | `0.388` | Target has three bursts; the source is one strengthening-magic burst. A real match likely needs repetition/layering. |
| `die` | `se_old_pack00/bell07.wav` | `speed` | 0 | `1.075x` | `0.368` | The Ascension sound is reportedly original. This is only a closest-texture substitute. |
| `disease` | `se_old_pack00/byoro06.wav` | `speed` | 0 | `1.034x` | `0.773` | Duration matches closely. `byoro09` is used by `upgrade-disease`. |
| `draw-game` | `se_old_pack00/eco01.wav` | `speed` | 0 | `1.155x` | `0.854` | Clear duration correction; the target also has an edit/gap near `0.5s`. |
| `phenomenon` | `se_old_pack00/alarm00.wav` | `speed` | 0 | `1.089x` | `0.790` | Duration-corrected long warning/ambient source. `bell07` is an alternative. |
| `reflect` | `se_old_pack00/eco03.wav` | `speed` | 0 | `1.365x` | `0.827` | “Approaching sound / saw through it” source, speed-corrected to the target length. |
| `remove-curses` | `se_old_pack00/alarm00r.wav` | `speed` | `+8` | `1.293x` | `0.719` | Fade point matches. `mizu10` is a semantic alternative. |
| `revive` | `se_old_pack00/bell14.wav` | `speed` | `-3` | `1.275x` | `0.719` | Bell-like harmonic tail, pitch-adjusted and speed-corrected. |
| `set-guardian` | `se_old_pack00/mecha23_a.wav` | `loop` | 0 | `2.75 loops` | `0.683` | Source is much shorter; looped to the target duration. `mecha01` is a duration-matched alternative. |
| `start-turn` | `se_old_pack00/bell13.wav` | `speed` | 0 | `0.938x` | `0.158` | Bell-like source, but the match is weak; `call01` is an alternative. |
| `win-game` | `se_old_pack00/bosu22_r.wav` | `raw` | 0 | — | `0.860` | Target is a sequence of several thuds; this is only the primary single-thud component. |

## Caveats

- CQT scores are normalized spectral-correlation values, not listening-quality
  scores. Values below roughly `0.6` mean the source is probably a component
  of a composite rather than a complete match.
- The edited files are useful as a starting point for manual sound design, not
  as guaranteed reconstructions of the original edits.
- `die` is reported as an original Godfield sound; the file here is a
  best-effort substitute, not a confirmed source match.
- If the goal is exact game audio rather than reconstructed source audio, use
  the files in `public/audio/` directly.
