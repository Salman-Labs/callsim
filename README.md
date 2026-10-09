# callsim (npm: voice-callsim)

Scripted caller tests for voice agents. callsim joins the agent as the caller, speaks a fixed script, and fails the run when latency, barge-in, DTMF, or the transcript misses a gate.

Two ways in:

- **Twilio Media Streams.** `callsim <ws-url>` connects as the Twilio side of a [bidirectional Media Stream](https://www.twilio.com/docs/voice/media-streams/websocket-messages). No phone number, no tunnel, no real call.
- **LiveKit.** `callsim run scenarios.yaml` joins a room as a SIP-shaped caller. It works against LiveKit Cloud or a throwaway `livekit-server --dev` in CI. The LiveKit client libraries are optional, so a Twilio-only install does not download them.

**callsim is not affiliated with, endorsed by, or sponsored by Twilio or LiveKit.** Twilio and Media Streams are trademarks of Twilio Inc. LiveKit is a trademark of LiveKit, Inc.

## The problem

Putting an AI voice bot on a Twilio number (an OpenAI Realtime bridge, for example) means buying a number, exposing localhost through a tunnel, and calling it by hand. The bugs worth catching do not show up in a request/response test:

- Choppy audio, because a 20 ms `setTimeout` drifts and Twilio's playback buffer underruns. [openclaw/openclaw#119070](https://github.com/openclaw/openclaw/issues/119070)
- Broken barge-in, because "how long the bot has been talking" was measured on a wall clock instead of audio that actually played, so `clear` cuts the wrong thing and the model thinks the caller heard words they never did. [openclaw/openclaw#138592](https://github.com/openclaw/openclaw/issues/138592)
- The practical tax of needing a public `wss://` endpoint before you can hear any of it. [jaylfc/dialtone#22](https://github.com/jaylfc/dialtone/issues/22)

## Install

Node 18 or newer. The package is ESM-only.

```bash
npm i -D voice-callsim
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

Installed from npm, the same flags are `npx voice-callsim ws://127.0.0.1:8080 ...`. The `callsim` command is the same binary.

`http://` and `https://` URLs are rewritten to `ws://` and `wss://`.

## Voice agents on LiveKit

`callsim run` reads a YAML scenario, opens one fresh room per scenario, and writes `callsim.report/1` JSON to `.callsim/runs/<runId>/report.json` plus a stereo `call.wav` (caller left, agent right) and `events.jsonl`. Exit codes stay 0 for pass, 1 for a failed check, and 2 for a usage or connection error.

Install the optional peers once:

```bash
npm install @livekit/rtc-node livekit-server-sdk
```

If they are missing, `callsim run` exits 2 and prints that install line. Keys come from the environment and are never printed: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

```yaml
name: Phone orders
transport: livekit
livekit:
  url: ${LIVEKIT_URL}
  agent_name: callra-agent          # omit to use automatic dispatch
  caller:
    kind: sip                       # falls back to standard, with a report warning, if the server rejects sip
    attributes:
      sip.phoneNumber: "+15550142"
      sip.trunkPhoneNumber: "+15557770000"
voice:
  tts: openai
  voice: alloy
  cache: .callsim/tts               # commit these wavs; CI then needs no TTS key
  phone_band: true                  # 8 kHz μ-law round trip, same codec as the Twilio path
defaults:
  max_first_audio_ms: 1500
  silence_ms: 700
scenarios:
  - label: Two large pepperonis for pickup
    tags: { feature: ordering }
    userdata: { restaurant_id: test-pizzeria }   # dispatch metadata
    turns:
      - expect: { agent_says_any: ["thanks for calling", "what can I get"] }
      - say: "Hi, can I get two large pepperoni pizzas for pickup?"
        expect:
          agent_heard: ["two", "pepperoni"]
          agent_says_any: ["anything else", "name"]
      - say: "Actually make one of them a margherita."
        barge_in_after_ms: 600
        expect: { max_yield_ms: 400 }
      - dtmf: "1"
        expect: { agent_says_any: ["confirmed", "placed"] }
    judge: "Final order is one pepperoni, one margherita, pickup."
    verify:
      http:
        url: https://orders.example/lookup?phone=${ORDER_PHONE}
        headers:
          authorization: Bearer ${ORDER_TOKEN}
        expect_status: 200
        expect_json:
          order.status: placed
```

`say:` is spoken with OpenAI TTS (`OPENAI_API_KEY`, plain `fetch`) and cached at `.callsim/tts/<sha256>.wav`. A line that is not cached, and has no key, exits 2. `audio:` plays a WAV file instead, which is what CI should use. `phone_band: true` runs that audio through μ-law before it is published.

The runner scores `agent_says_any`, `agent_says_all`, `agent_says_regex`, `agent_not_says`, `agent_heard` (the agent's own transcript of the caller), `agent_silent`, `max_first_audio_ms`, `max_yield_ms`, and `max_agent_audio_after_barge_ms`. `defaults` fills in the numeric gates and `silence_ms`. Turn end is `AudioSource.waitForPlayout()`, not the moment the last frame was queued. Barge-in yield is the time from the start of caller audio until the agent's audio stays under an energy VAD for 200 ms. Agent text comes from the `lk.transcription` text stream (what the agent said, and what it heard). `lk.agent.state` is read when the agent publishes it. DTMF uses `publishDtmf`. The room is deleted on hangup.

`judge` calls an OpenAI-compatible chat endpoint (`OPENAI_BASE_URL` or `OPENAI_API_KEY`) and does not fail the run unless you pass `--judge-required`. With neither variable set, the report says the judge was skipped. `verify` is a generic order or state check: a shell command (`{ run, expect_exit }`) or an HTTP request whose JSON is compared with a path-equals map. `${VAR}` is read from the environment; a missing name is an error that names the variable and not its value.

```bash
npx voice-callsim run scenarios/*.yaml --label "Two large pepperonis for pickup" --json --ci --junit callsim.xml
```

`run` ships in 0.2. Until that version is published, use `node dist/cli.js run` from a checkout of this repo. The Twilio command in the CI section below is the published 0.1 CLI.

`examples/scenarios/order.yaml` is the same shape, played from `fixtures/*.wav` so it needs no TTS key. `npm run example:livekit-good` is a scripted participant (kind agent) that handles barge-in. `npm run example:livekit-buggy` keeps talking and then goes silent. Against `livekit-server --dev` the good one passes and the buggy one fails the yield and silence checks.

### CI, self-hosted

Download a pinned `livekit-server`, check its checksum, and start `--dev` (API key `devkey`, secret `secret`, port 7880). This repo's LiveKit job does that from `test/livekit-server.ts` (v1.13.9, sha256 `0b7fa208b662d09cfdeae8c06cf4c481aead0556086558b48250501e2e2d6e20` for the linux amd64 archive). A workflow for your own agent:

```yaml
name: voice-agent
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
      - name: Start livekit-server
        run: |
          curl -fsSL -o livekit.tgz https://github.com/livekit/livekit/releases/download/v1.13.9/livekit_1.13.9_linux_amd64.tar.gz
          echo "0b7fa208b662d09cfdeae8c06cf4c481aead0556086558b48250501e2e2d6e20  livekit.tgz" | sha256sum -c -
          tar -xzf livekit.tgz
          ./livekit-server --dev &
      - name: Start the agent worker
        run: npm start &
        env:
          LIVEKIT_URL: ws://127.0.0.1:7880
          LIVEKIT_API_KEY: devkey
          LIVEKIT_API_SECRET: secret
      - name: Scripted calls
        run: npx --yes voice-callsim run scenarios/*.yaml --ci --junit callsim.xml
        env:
          LIVEKIT_URL: ws://127.0.0.1:7880
          LIVEKIT_API_KEY: devkey
          LIVEKIT_API_SECRET: secret
```

There is no musl build of `@livekit/rtc-node`. Use a glibc runner (`ubuntu-latest`), not Alpine.

### CI, LiveKit Cloud

Point the same scenario at the Cloud project URL and the staging worker's `agent_name`. No `livekit-server` process. The secret stays in the CI secret store:

```yaml
      - name: Scripted calls
        run: npx --yes voice-callsim run scenarios/*.yaml --ci --junit callsim.xml
        env:
          LIVEKIT_URL: ${{ secrets.LIVEKIT_URL }}
          LIVEKIT_API_KEY: ${{ secrets.LIVEKIT_API_KEY }}
          LIVEKIT_API_SECRET: ${{ secrets.LIVEKIT_API_SECRET }}
```

If Cloud rejects a token with participant kind `sip`, callsim reconnects as `standard`, keeps the `sip.*` attributes, and records a warning on the report. That fallback is what makes the caller work on Cloud as well as on `--dev`. Kind `sip` on Cloud was not verified in this repo's CI, which runs the dev server.

### Transport interface

Scenario files do not talk to a vendor SDK. They talk to a `Transport`: `connect`, `waitForAgent`, `playCallerAudio` (real playout, not enqueue), `sendDtmf`, an agent-audio stream with energy VAD start and stop, agent transcript events, the caller's heard text when the platform has it, and `hangup`. LiveKit is the first implementation (`createLiveKitTransport`). Twilio, Vapi, Retell, and SIP can implement the same interface later. The existing `simulateCall` API and `callsim <ws-url>` behavior are unchanged.

## Use with coding agents

`callsim mcp` is a stdio MCP server. The tools are `list_scenarios`, `validate_scenario`, `run_scenario`, `get_report`, `list_runs`, and `compare_runs`. `run_scenario` is not read-only: it can spend the agent under test its own STT, LLM, and TTS. The server runs one scenario at a time and does not return API keys. `validate_scenario` names missing environment variables and does not print their values.

A skill ships at `skills/callsim/SKILL.md` (included in the npm package):

```bash
npx skills add Salman-Labs/callsim
```

Install lines below were checked against the current docs (Claude Code stdio, Cursor `mcp.json`, Codex MCP).

Claude Code ([stdio servers](https://code.claude.com/docs/en/mcp)):

```bash
claude mcp add callsim -- npx -y voice-callsim mcp
```

Cursor ([mcp.json](https://cursor.com/docs/mcp)), project file `.cursor/mcp.json` or global `~/.cursor/mcp.json`. The STDIO `type` field is required:

```json
{
  "mcpServers": {
    "callsim": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "voice-callsim", "mcp"]
    }
  }
}
```

Codex ([`codex mcp add`](https://learn.chatgpt.com/docs/extend/mcp)):

```bash
codex mcp add callsim -- npx -y voice-callsim mcp
```

From a checkout of this repo, before 0.2 is published, the same server is `node dist/cli.js mcp`.

## CLI

The npm package is `voice-callsim`. Both `voice-callsim` and `callsim` run the same CLI.

```text
voice-callsim <ws-url> [options]
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
npx voice-callsim ws://127.0.0.1:8080 --audio ./caller.wav --out ./call.wav
```

8 kHz mono μ-law or PCM is used as-is. Stereo is mixed to mono. Other sample rates are resampled to 8 kHz. The file must be a WAV (PCM 8-bit, PCM 16-bit, or μ-law).

## Library

`simulateCall` returns the typed report and the stereo WAV buffer. Use it from Vitest or Jest.

```ts
import { expect, it } from 'vitest';
import { simulateCall } from 'voice-callsim';

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
          npx --yes voice-callsim@0.1.0 ws://127.0.0.1:8080
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
