# Godfield audio source notes

This directory contains the WAV versions of the Godfield sound effects used by
the client. File names match the `sounds` keys in `src/services/audio.ts`.

- The root contains 65 `.wav` files.
- `poor.mp3` is intentionally **not** converted: the matching original in
  `se_old_pack00` only exists as `warp03.mp3`, so it is copied as-is.
- `edited/` contains 18 reconstructed versions of the effects that appear to
  have been pitch-shifted, speed-changed, trimmed, looped, or assembled from
  multiple sources. See `edited/README.md` for the applied transforms.

The source sound packs used for this analysis are not included in this repository. The comparisons used:

1. Mono decoding and waveform cross-correlation for exact source detection.
2. Shazam-style spectral-peak hash matching.
3. Constant-Q (log-frequency) 2D normalized cross-correlation, allowing time
   and pitch shifts.
4. Duration, onset, envelope, and spectrogram comparison.
5. The source-file comments from the archived ザ・マッチメイカァズ pages.

MP3 encoding adds delay and lossy artifacts, so waveform correlation below
about `0.9` usually means the game audio was edited, filtered, pitch-shifted,
time-stretched, or assembled from more than one source.

## High-confidence matches

These are direct or near-direct copies of one source file. Most have waveform
correlation above `0.75`; `hit` was also independently confirmed from the
public Godfield sound-material notes.

| Effect | Source |
|---|---|
| `add-curse` | `se_old_pack00/byoro06.wav` |
| `add-item` | `se_old_pack00/power14.wav` |
| `atk-by-2x-mp` | `se_old_pack00/power37.wav` |
| `attract-danger` | `se_old_pack00/don20.wav` |
| `boost-cp` | `se_080402r/tm2_coin000.wav` |
| `boost-hp` | `se_080719r/tm2_pon001.wav` |
| `bounce` | `se_old_pack00/power23.wav` |
| `buy` | `se_080330r/tm2_slidedoor003.wav` |
| `cancel-entry` | `se_old_pack00/clock01.wav` |
| `cancel-item` | `se_080330r/tm2_counter000.wav` |
| `click` | `se_old_pack00/call07.wav` |
| `command` | `se_old_pack00/bosu10_c.wav` |
| `counter-attack` | `se_080327r/tm2_sonic000.wav` |
| `darkcloud` | `se_old_pack00/hit79.wav` |
| `deal-damage` | `se_old_pack00/hit23.wav` |
| `devil-to-deal-damage-1` | `se_080402r/tm2_scratch000.wav` |
| `devil-to-deal-damage-2` | `se_old_pack00/hit17.wav` |
| `devil-to-deal-damage-3` | `se_old_pack00/gun09_r.wav` |
| `devil-to-remove-something` | `se_old_pack00/voice011.wav` |
| `dream` | `se_080719r/tm2_mecha002_dashed.wav` |
| `exchange` | `se_old_pack00/on11.wav` |
| `fog` | `se_old_pack00/mizu01.wav` |
| `gift` | `se_old_pack00/kachi00.wav` |
| `hit` | `se_old_pack00/hit49.wav` |
| `increase` | `se_old_pack00/on14.wav` |
| `make-entry` | `se_old_pack00/clock00.wav` |
| `miss` | `se_old_pack00/swing32.wav` |
| `move-cp` | `se_old_pack00/coin06.wav` |
| `pray` | `se_old_pack00/buble03.wav` |
| `redraw` | `se_080402r/tm2_sonic004.wav` |
| `reference` | `se_old_pack00/paper00.wav` |
| `remove-guardian` | `se_old_pack00/bell15b.wav` |
| `remove-items` | `se_080327r/tm2_fadeout000.wav` |
| `sacrifice` | `se_old_pack00/noise15.wav` |
| `safe` | `se_old_pack00/pi08.wav` |
| `select-item` | `se_080330r/tm2_put000.wav` |
| `self-curse` | `se_080408r/tm2_quiz002bad.wav` |
| `show-removed-item` | `se_081022r/tm2_chair002.wav` |
| `shuffle-teams` | `se_080402r/tm2_bone000.wav` |
| `start-game` | `se_080408r/tm2_chime002.wav` |
| `target-player` | `se_old_pack00/pi38.wav` |
| `tiebreak` | `se_old_pack00/alarm00.wav` |
| `time-gauge-alarm` | `se_080402r/tm2_mind000.wav` |
| `turn-player` | `se_081022r/tm2_pon002.wav` |
| `upgrade-disease` | `se_old_pack00/byoro09.wav` |
| `upgrade-heaven` | `se_old_pack00/crash26.wav` |
| `use-no-items` | `se_old_pack00/wood07.wav` |

## Observed differences and probable matches

These effects do not match a single source cleanly. The chosen source is the
most likely primary component, but the shipped game audio is an edit, a
pitch/time variation, or a composite. The “best transform” values come from
CQT matching and are approximate; low CQT scores mean the transform should be
treated as a suggestion only.

| Effect | Probable source | Target / source duration | Observed difference | Possible way to match |
|---|---|---|---|---|
| `alert` | `se_old_pack00/alarm01.wav` | `0.575s` / `3.084s` | Very short target cut from a long warning; onset pattern and spectral match are weak. `alarm00` and `jihou00` are alternatives. | Find the active warning segment, trim to `0.575s`, then test pitch/time offsets. Add a short fade-out. |
| `attack-by-guardian` | `se_old_pack00/cursor03.wav` | `0.522s` / `0.624s` | Strong spectral match (`0.934`), but the source is a short UI selection sound; the game version has a different envelope/tail. | Trim the source to the target, apply a short fade, and compare the low-frequency tail. |
| `attack-dyingly` | `se_old_pack00/voice025.wav` | `1.463s` / `1.921s` | Probable scream-based edit. The target has a silent gap and a second attack, suggesting a composite. | Layer a scream/voice with a hit or swing source; time-stretch the voice to about `0.76x` and align the second hit. |
| `block` | `se_old_pack00/metal48.wav` | `0.418s` / `0.379s` | Very strong spectral match (`0.951`); target is slightly longer and has a different decay. | Add a short tail or light reverb, then match the fade/decay. |
| `boost-mp` | `se_old_pack00/buble00.wav` | `0.955s` / `0.910s` | Similar duration and noise texture, but the target has a stronger low-frequency attack. `power05`, `power06`, and `power09` are plausible alternatives. | Try all `power` variants; apply a low shelf, pitch/time alignment, and match the initial transient. |
| `confusion` | `se_old_pack00/voice029.wav` | `0.810s` / `0.513s` | Voice-like harmonic formants; target is longer. `voice033` (ape-man) is an alternative. | Time-stretch the voice to about `1.5x`; preserve pitch or pitch up slightly, then add the target’s decay. |
| `deal-dark-damage` | `se_old_pack00/noise10.wav` | `1.515s` / `0.774s` | Target is a harsh broadband noise about twice the source length. `warp03`/`warp03r` are possible alternatives. | Loop or stretch `noise10` to the target length, pitch it down, and smooth the loop point. |
| `devil-to-boost-something` | `se_old_pack00/power35.wav` | `1.071s` / `0.621s` | Target contains three separated bursts; `power35` is a single strengthening-magic burst. | Repeat/concatenate `power35` or layer `power34`/`power35` with a voice; align each burst to the target’s onsets. |
| `die` | `se_old_pack00/bell07.wav` | `3.657s` / `3.932s` | Long, dark rumble. Godfield’s Ascension sound is reportedly original, not a direct stock file; `bell07` is only the closest texture. | Keep the game audio for this one, or document it as original. If a stock substitute is required, use `bell07` with a low-pass filter and subtle pitch drop. |
| `disease` | `se_old_pack00/byoro06.wav` | `0.627s` / `0.648s` | Duration matches closely; `byoro09` is already used by `upgrade-disease`, so this is likely the paired “sick” variant. | Light pitch/time adjustment only; compare against `drag02` and `byoro09` if the intended variant is different. |
| `draw-game` | `se_old_pack00/eco01.wav` | `1.384s` / `1.599s` | CQT match `0.864`; target is about `0.86x` the source length at the same pitch, with an edit/gap near `0.5s`. | Time-compress to `0.86x`, then cut/fade around the target’s `0.5s` change. |
| `phenomenon` | `se_old_pack00/alarm00.wav` | `2.821s` / `3.073s` | CQT match `0.795`; target is about `0.82x` the source length at the same pitch. | Time-compress to `0.82x` and trim the tail. `bell07` is an alternative. |
| `reflect` | `se_old_pack00/eco03.wav` | `0.914s` / `1.248s` | CQT match `0.869`; target is about `0.66x` the source length at the same pitch. The source comment is “approaching sound / saw through it”, which fits `reflect`. | Time-compress to `0.66x` or use the matching `0.914s` region; add the target’s short tail. |
| `remove-curses` | `se_old_pack00/alarm00r.wav` | `3.004s` / `3.883s` | CQT match `0.826`; both fade near `2.5s`. Best transform is about `0.60x` time and `+8` semitones. `mizu10` (water submerge) is a semantic alternative. | Pitch up about eight semitones, time-compress to about `0.60x`, then match the `2.5s` fade. |
| `revive` | `se_old_pack00/bell14.wav` | `0.993s` / `1.265s` | Bell-like harmonic tail; best transform is about `0.74x` time and `-3` semitones. | Pitch down three semitones, time-compress to about `0.74x`, and match the decay. |
| `set-guardian` | `se_old_pack00/mecha23_a.wav` | `2.847s` / `1.036s` | Source is much shorter and likely looped; CQT match `0.836`. `mecha01` matches the target duration better. | Loop/concatenate the startup sound to `2.847s` with crossfades, or try `mecha01` as a duration-matched alternative. |
| `start-turn` | `se_old_pack00/bell13.wav` | `1.646s` / `1.544s` | Bell-like tone; CQT match only `0.691`, so the exact edit is uncertain. `call01` (telephone ring) is an alternative. | Trim/reverb-match `bell13`; if it is wrong, test the telephone-ring sources with pitch/time offsets. |
| `win-game` | `se_old_pack00/bosu22_r.wav` | `0.758s` / `0.720s` | Target has four or five thuds; the source is a single fighting-game down thud. CQT match `0.876` comes from one thud. | Use `bosu22_r` as the primary component and sequence several `bosu`/thud hits to match the target’s onset pattern. |

## General matching recipe

For a sound that is a transformed single source:

1. Estimate duration ratio = `target_duration / source_duration`.
2. Estimate pitch shift from CQT peak displacement. One CQT bin is one
   semitone (`bins_per_octave = 12`), so pitch ratio = `2 ** (bins / 12)`.
3. Apply time and pitch separately:
   - `librosa.effects.time_stretch(y, rate=source_len / target_len)`
   - `librosa.effects.pitch_shift(y, sr=sr, n_steps=bins)`
   - or ffmpeg filters such as `atempo` plus `asetrate`/`aresample`.
4. Align the first strong onset, then trim or pad to the target duration.
5. Match the envelope with fade-in/fade-out, a short reverb, or a low/high
   shelf filter.
6. Verify with normalized waveform cross-correlation and CQT correlation. A
   good match is usually above `0.9` waveform correlation for a stock sound,
   or above roughly `0.85` CQT correlation for a time/pitch-edited sound.

For a composite sound:

1. Split the target at its energy dips/onsets.
2. Match each segment independently against the source packs.
3. Reassemble the segments with the target’s timing.
4. For layered sounds, subtract the best-matching layer and search the residual.

## Caveats

- The old pack contains both 8-bit/22.05 kHz and 16-bit/44.1 kHz files; the
  copied WAVs preserve their original format.
- A few game sounds use Adobe Soundbooth tags, while others are LAME/Lavf
  encodes. That difference usually indicates which generation of the game the
  asset came from, not a different source.
- `poor` has no WAV source in the pack. It is copied as `poor.mp3` from
  `se_old_pack00/warp03.mp3`; do not run it through a lossy-to-lossless
  conversion if preserving the original is the goal.
