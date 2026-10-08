# callsim

Test a Twilio Media Streams voice bot on your laptop and in CI. No phone number, no tunnel, no real call.

callsim connects to your bot as the Twilio side of a [bidirectional Media Stream](https://www.twilio.com/docs/voice/media-streams/websocket-messages). It speaks the WebSocket protocol, plays caller audio in real time, and reports the failures that only show up on a live line: pacing drift, a barge-in that never clears, and a slow first response.

**callsim is not affiliated with, endorsed by, or sponsored by Twilio.** Twilio and Media Streams are trademarks of Twilio Inc.

## The problem

Putting an AI voice bot on a Twilio number (an OpenAI Realtime bridge, for example) means buying a number, exposing localhost through a tunnel, and calling it by hand. The bugs worth catching do not show up in a request/response test:

- Choppy audio, because a 20 ms `setTimeout` drifts and Twilio's playback buffer underruns. [openclaw/openclaw#119070](https://github.com/openclaw/openclaw/issues/119070)
- Broken barge-in, because "how long the bot has been talking" was measured on a wall clock instead of audio that actually played, so `clear` cuts the wrong thing and the model thinks the caller heard words they never did. [openclaw/openclaw#138592](https://github.com/openclaw/openclaw/issues/138592)
- The practical tax of needing a public `wss://` endpoint before you can hear any of it. [jaylfc/dialtone#22](https://github.com/jaylfc/dialtone/issues/22)

## Install

Node 18 or newer. The package is ESM-only.

```bash
npm install --save-dev callsim
```

From a clone of this repo:

```bash
git clone https://github.com/Salman-Labs/callsim.git
cd callsim
npm ci
npm run build
```

## Quick start

Terminal 1, a bot that handles `clear` and keeps its playback buffer fed:

```bash
npm run example:good
```

Terminal 2:

```bash
node dist/cli.js ws://127.0.0.1:8080 --say hello --barge-in 0.2 --out call.wav \
  --ci --max-first-audio-ms 400 --max-gap-ms 40 --require-barge-in
```

The same command against `npm run example:buggy` (port 8081) exits 1. That bot answers late, sends audio in bursts, and ignores barge-in.

`http://` and `https://` URLs are rewritten to `ws://` and `wss://`.

## CLI

```text
callsim <ws-url> [options]
```

| Flag | Meaning |
| --- | --- |
| `--say <text>` | Caller turn. Repeatable, in order. `hello`, `yes`, `okay`, and `goodbye` use bundled fixtures. Any other text is spoken with the built-in formant synthesizer. |
| `--audio <file.wav>` | Caller turn from a WAV file. PCM or μ-law, any sample rate, mixed down and resampled to 8 kHz mono. |
| `--barge-in <seconds>` | Start each later turn this long after the bot starts speaking, overlapping playback. A single `--say` or `--audio` is played again as the interruption. |
| `--silence <seconds>` | Quiet time after the bot finishes, before the next turn. Default `0.5`. Ignored for turns that barge in. |
| `--timeout <seconds>` | Whole-call limit. Default `30`. |
| `--param key=value` | Entry in `start.customParameters`. Repeatable. |
| `--dtmf <digits>` | Send `0-9`, `*`, and `#` after the last caller turn. |
| `--jitter <ms>` | Add up to N milliseconds of random delay to each caller frame. Frames stay in order. Default `0`. |
| `--out <call.wav>` | Stereo WAV. Left is the caller, right is bot audio at the simulated play head. |
| `--json` | Print the report as JSON. |
| `--ci` | Exit 1 when a threshold fails. |
| `--max-first-audio-ms <n>` | Fail if any turn's first bot audio is slower than this, or missing. |
| `--max-gap-ms <n>` | Fail if the longest mid-utterance playback gap exceeds this. |
| `--require-barge-in` | Fail unless every interrupting turn gets `clear` and the bot stops sending (one in-flight frame is allowed). |

With `--ci` and none of the threshold flags, the defaults are `--max-first-audio-ms 1500`, `--max-gap-ms 100`, and `--require-barge-in` when `--barge-in` was set. Exit code 2 is a usage or connection error. Exit code 1 is a failed call or a failed threshold.

## Sample output

Good bot, `ws://127.0.0.1:8080 --say hello --barge-in 0.2 --ci --max-first-audio-ms 400 --max-gap-ms 40 --require-barge-in`:

```text
callsim ws://127.0.0.1:8080

Turn  Caller  First audio  Barge-in
────  ──────  ───────────  ──────────────────────────
1     hello   41 ms        —
2     hello   41 ms        clear in <1 ms, 0 ms after

Underruns        0 (longest gap 0 ms)
Format problems  0
Marks echoed     2  (1 played, 1 cleared, 2 from bot)
Duration         1.195 s
Result           PASS
```

Buggy bot, same flags:

```text
callsim ws://127.0.0.1:8081

Turn  Caller  First audio  Barge-in
────  ──────  ───────────  ────────
1     hello   592 ms       —
2     hello   651 ms       no clear

Underruns        6 (longest gap 124 ms)
Format problems  0
Marks echoed     2  (2 played, 0 cleared, 2 from bot)
Duration         2.725 s
Result           FAIL

- turn 1 (hello) first audio 592 ms exceeds 400 ms
- turn 2 (hello) first audio 651 ms exceeds 400 ms
- longest playback gap 124 ms exceeds 40 ms (6 underruns)
- turn 2 barge-in did not receive clear
```

A terminal colors passing numbers green and failing ones red. `--json` prints the same report without the WAV bytes. `msToClear` of `0` is a sub-millisecond clear; the table prints that as `<1`.

## Metrics

| Metric | What it measures |
| --- | --- |
| First audio | Milliseconds from the last frame of a caller turn to the start of the next bot utterance. Audio still playing from an earlier turn does not count. |
| Underruns | Times the bot's playback buffer ran dry and more audio for the same utterance arrived later. Gaps under 35 ms are timer noise and are ignored. `longestGapMs` is the worst one. |
| Format problems | Bot frames that are not raw 8 kHz μ-law: invalid base64, an empty payload, a WAV/AU/Ogg header, a length that is not a multiple of 160 bytes (20 ms), a missing or mismatched `streamSid`, or binary WebSocket frames. |
| Barge-in | Whether `clear` arrived, how many milliseconds after the interrupting caller audio started, and how much bot audio arrived after `clear` before that caller turn finished. A later reply, after the caller stops, is a new turn, not "audio after clear". |
| Marks echoed | Marks the bot sent, split into ones echoed because playback reached them and ones echoed immediately because `clear` discarded the audio in front of them. That matches current Twilio behavior: a cleared mark comes back so the bot knows it will not be played. |
| Duration | Wall time from the `start` message to the end of the simulated call. |

`--barge-in` has to land while the bot is still playing. If it is longer than the bot's utterance, the interruption is just the next turn and `clear` is not expected.

## Caller audio

`--say hello` plays `fixtures/hello.wav`. The bundled phrases are `hello`, `yes`, `okay`, and `goodbye`: short synthetic utterances generated by `scripts/generate-fixtures.ts` and checked in so those four lines stay stable. They are not recordings of a person.

Any other `--say` text is rendered with the same synthesizer at runtime. It is a deterministic formant buzz timed like phonemes, with no network and no native library. It is speech-like enough to drive a bot. It is not a voice.

For something a person would recognize, pass your own file:

```bash
callsim ws://127.0.0.1:8080 --audio ./caller.wav --out ./call.wav
```

8 kHz mono μ-law or PCM is used as-is. Stereo is mixed to mono. Other sample rates are resampled to 8 kHz. The file must be a WAV (PCM 8-bit, PCM 16-bit, or μ-law).

## Library

`simulateCall` returns the typed report and the stereo WAV buffer. Use it from Vitest or Jest.

```ts
import { expect, it } from 'vitest';
import { simulateCall } from 'callsim';

it('answers quickly and clears on barge-in', async () => {
  const report = await simulateCall({
    url: 'ws://127.0.0.1:8080',
    turns: [{ text: 'hello' }, { text: 'yes' }],
    bargeIn: 0.2,
    thresholds: {
      maxFirstAudioMs: 800,
      maxGapMs: 60,
      requireBargeIn: true,
    },
  });

  expect(report.ok).toBe(true);
  expect(report.underruns.count).toBe(0);
  expect(report.bargeIn[0]?.clearReceived).toBe(true);
  expect(report.recordingWav.subarray(0, 4).toString()).toBe('RIFF');
});
```

`turns` also accepts `wavPath`, `pcm16` (with optional `sampleRate`), or raw 8 kHz `mulaw` bytes. This repo's own tests start `examples/good-bot.ts` and `examples/buggy-bot.ts` in-process and assert that the good bot passes and the buggy bot fails on underruns and a missing `clear`.

## CI

Run callsim against your bot on every pull request. Pin the actions to full commit SHAs.

```yaml
name: voice-bot
on: [pull_request]
permissions:
  contents: read
jobs:
  callsim:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - name: Start the bot
        run: node dist/server.js &
      - name: Media stream regression
        run: >
          npx --yes callsim@0.1.0 ws://127.0.0.1:8080
          --say hello --barge-in 0.2 --ci
          --max-first-audio-ms 800
          --max-gap-ms 60
          --require-barge-in
```

This repository's own [CI workflow](.github/workflows/ci.yml) typechecks and runs the simulator tests on Node 18, 20, and 22.

## What the simulator sends

On connect, callsim sends `connected` (`protocol: "Call"`, `version: "1.0.0"`), then `start` with `streamSid`, `callSid`, `accountSid`, `tracks: ["inbound"]`, your `customParameters`, and `mediaFormat` of `audio/x-mulaw`, 8000 Hz, mono. Caller audio follows as base64 μ-law `media` messages, one 20 ms frame at a time, on a monotonic clock so the frame budget does not drift. `sequenceNumber`, `chunk`, and `timestamp` all increase the way Twilio's do. Optional `dtmf` uses track `inbound_track`. The call ends with `stop`.

Bot `media` is buffered and played at 8 kHz. A `mark` is echoed when every audio chunk queued before it has been consumed, or immediately if `clear` drops that audio. `clear` also throws away the unplayed samples, which is what shows up in `--out`.

## Limitations

This is a simulator. There is no PSTN, no carrier, and no Twilio signature check, because callsim is the side that places the stream. Jitter, loss, and packet reordering are not modeled unless you pass `--jitter <ms>`, which only delays caller frames by a random amount up to that budget and does not reorder them. Bot audio is played on a local clock, not through Twilio's real jitter buffer. One `simulateCall` is one bidirectional stream. callsim does not fetch TwiML; point it at the Media Stream WebSocket your bot already serves.

## License

MIT. Copyright Salman Labs. See [LICENSE](LICENSE).

Security reports: [GitHub private vulnerability reporting](https://github.com/Salman-Labs/callsim/security/advisories/new). See [SECURITY.md](SECURITY.md).
