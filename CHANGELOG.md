# Changelog

## Unreleased

- A reply ends after `defaults.reply_quiet_ms` (default 700) of agent quiet, not at the first pause between sentences (LiveKit and Twilio). The same holds for the greeting turn and for a caller line waiting for the agent to finish. The reply start window is 8 s (was 4 s), and a reply may run 30 s.
- LiveKit agent text is read as it streams. A stream opened with `lk.transcription_final: "false"` (LiveKit Agents) is final when it closes. Word checks wait up to 3 s after the reply for that final text, and a segment counts toward the turn in which it started.
- `report.transcript` includes the agent's lines. Caller lines from `audio:` carry what the agent heard instead of the WAV file name, and a `heard` field.
- `defaults.max_first_audio_ms` no longer applies to caller turns with no `expect`.
- `timeout_ms` on a scenario file or a scenario. Scenario beats file, which beats `--timeout`.
- LiveKit API errors name the cause under `fetch failed` (TLS, refused connection). A `LIVEKIT_URL` with a path prefix reaches the server API under that prefix; the room already did.
- The example LiveKit agent speaks multi-sentence replies and publishes text the way LiveKit Agents does. Tests can use a local `livekit-server` through `LIVEKIT_SERVER_BIN`.

## 0.2.1

- LiveKit `callsim run` disconnects the room, removes every participant and track, clears timers and native handles, and exits. Pass is exit 0. A failed check is nonzero.
- Scenario examples name the worker `my-voice-agent`.
- `callsim run --help` documents `transport: twilio`. The one-shot `callsim <ws-url>` command is unchanged.
- The README CI example pins `voice-callsim@0.2.1`.
- Twilio barge-in reports `ok: false` when `clear` was not received.
