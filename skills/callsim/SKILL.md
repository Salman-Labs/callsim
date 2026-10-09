---
name: callsim
description: Run scripted test phone calls against a LiveKit or Twilio Media Streams voice agent and read latency, barge-in, DTMF and transcript checks. Use when asked to test, call, or regression-check a voice agent.
---

# callsim

callsim places a scripted caller against a voice agent and fails the run when latency, barge-in, DTMF, or the transcript misses a gate. The scenario file is the same shape across platforms. LiveKit is the `callsim run` transport. Twilio Media Streams still uses `callsim <ws-url>`.

## Before running

1. Do not print API keys, API secrets, or access tokens. If a command would echo them, stop.
2. For LiveKit, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` must be set. Confirm with a name-only check (`callsim validate <file>` lists missing names). Never print the values.
3. The agent worker is running. If the scenario sets `agent_name`, the worker is registered under that name. With no `agent_name`, unnamed workers join every new room.
4. Install the LiveKit peers once when that transport is used: `npm install @livekit/rtc-node livekit-server-sdk`.
5. `callsim validate <file>` before the first run. Fix schema errors and missing env names first.

## Run

Prefer the MCP tool `run_scenario`. It returns a compact summary and a `runId`. One run at a time.

Otherwise:

```bash
npx voice-callsim run <file> --json
```

Add `--label`, `--tags key=value`, `--ci`, and `--junit out.xml` when a subset or a CI gate is needed. Read `.callsim/runs/<runId>/report.json`. `get_report` can add `turns`, `transcript`, or `events`.

`run_scenario` can spend the agent under test its own speech and model calls. It is not a read-only tool.

## Triage

| What failed | What to check |
| --- | --- |
| `agent_not_joined` | The worker process, and that `agent_name` matches the name it registered. Automatic dispatch only picks up workers that did not set a name. |
| `agent_heard` does not match | Caller audio, the TTS cache, and `phone_band`. This text is the agent's own transcript of the caller, not a second STT pass inside callsim. |
| `firstAudioMs` is high | Open `events.jsonl` and split the wait by `lk.agent.state` (`listening`, `thinking`, `speaking`) when the agent publishes it. |
| `yieldMs` is high | The agent's interruption and endpointing settings. Yield is measured from the start of caller audio until agent audio stays quiet. |
| Silent after an interruption | The agent produced no new utterance after barge-in. On LiveKit Agents this is the class of bug where an interrupted reply never starts the next one. |
| Exit code 2 | Usage or connection: missing env, missing optional LiveKit packages, or the room could not be joined. Exit code 1 is a failed check. |

## Writing scenarios

- One complication per scenario. A barge-in case should not also be the only place that checks the transfer flow.
- Prefer `agent_says_any` or `agent_says_regex` over a full expected sentence. Agent wording moves.
- Put numeric gates in `defaults` (`max_first_audio_ms`, `silence_ms`) and override them on the turn that needs a tighter bound.
- Use `audio:` WAV files, or commit `.callsim/tts/<sha256>.wav`, so a rerun does not need a TTS key.
- When the pass condition is something the caller cannot hear (an order row, a ticket, a webhook), add `verify`. That is either `{ run, expect_exit }` or `{ http: { url, expect_status, expect_json } }`. `expect_json` is a map of dotted paths to expected values. Put secrets in `${VAR}` and keep them out of the file.
- If a scenario mentions a date, write the absolute date. Do not say "next Tuesday".

## Cost

Each run bills the agent under test for its own STT, LLM, and TTS, and LiveKit Cloud minutes when the room is not a local `livekit-server`. While iterating, pass `tags` (or `--tags`) and run that subset. The optional `judge` is off unless `OPENAI_API_KEY` or `OPENAI_BASE_URL` is set, and it does not fail the run unless `--judge-required` is passed.

## When to use LiveKit's own tools

- Text-only logic, with no audio and no room: `lk agent debugger`.
- An open-ended LLM caller, word-error rate, and Cloud dashboards: `lk agent simulate audio`.
- A fixed script, numeric gates, a SIP-shaped caller, DTMF, or a self-hosted `livekit-server --dev` in CI: callsim.

callsim is not affiliated with Twilio or LiveKit.
