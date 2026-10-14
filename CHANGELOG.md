# Changelog

## 0.2.1

- LiveKit `callsim run` disconnects the room, removes every participant and track, clears timers and native handles, and exits. Pass is exit 0. A failed check is nonzero.
- Scenario examples name the worker `my-voice-agent`.
- `callsim run --help` documents `transport: twilio`. The one-shot `callsim <ws-url>` command is unchanged.
- The README CI example pins `voice-callsim@0.2.1`.
- Twilio barge-in reports `ok: false` when `clear` was not received.
