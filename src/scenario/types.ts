export interface ScenarioFile {
  name?: string;
  transport: string;
  livekit?: LiveKitFileConfig;
  voice?: VoiceConfig;
  defaults?: ScenarioDefaults;
  scenarios: ScenarioCase[];
  /** Directory containing the file. Set by the loader. */
  dir: string;
  /** Path of the file. Set by the loader. */
  path: string;
}

export interface LiveKitFileConfig {
  url?: string;
  agent_name?: string;
  join_timeout_ms?: number;
  caller?: {
    kind?: 'sip' | 'standard';
    attributes?: Record<string, string>;
  };
}

export interface VoiceConfig {
  tts?: string;
  voice?: string;
  cache?: string;
  phone_band?: boolean;
}

export interface ScenarioDefaults {
  max_first_audio_ms?: number;
  max_yield_ms?: number;
  max_agent_audio_after_barge_ms?: number;
  silence_ms?: number;
}

export interface ScenarioCase {
  label: string;
  tags?: Record<string, string>;
  userdata?: unknown;
  turns: ScenarioTurn[];
  judge?: string;
  verify?: ScenarioVerify;
}

export interface ScenarioTurn {
  say?: string;
  audio?: string;
  dtmf?: string;
  wait_ms?: number;
  silence_ms?: number;
  barge_in_after_ms?: number;
  expect?: Expectation;
  hangup?: boolean;
}

export interface Expectation {
  agent_says_any?: string[];
  agent_says_all?: string[];
  agent_says_regex?: string;
  agent_not_says?: string[];
  agent_heard?: string[];
  agent_silent?: boolean;
  max_first_audio_ms?: number;
  max_yield_ms?: number;
  max_agent_audio_after_barge_ms?: number;
}

export type ScenarioVerify =
  | { run: string; expect_exit?: number }
  | {
      http: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        expect_status?: number;
        expect_json?: Record<string, unknown>;
      };
    };

export interface CheckResult {
  type: string;
  ok: boolean;
  value?: number | string | boolean;
  limit?: number;
  detail?: string;
}

export interface ReportTurn {
  i: number;
  caller?: { text?: string; audioMs: number; startedAt?: number; endedAt: number };
  agent: {
    said: string;
    heard: string;
    firstAudioMs: number | null;
    speechMs: number | null;
    interrupted: boolean;
  };
  checks: CheckResult[];
}

export interface ReportBargeIn {
  turn: number;
  yieldMs: number;
  agentAudioAfterMs: number;
  ok: boolean;
}

export interface ReportDtmf {
  turn: number;
  digits: string;
}

export interface ReportTranscriptLine {
  role: 'agent' | 'caller';
  text: string;
  t: number;
}

export interface JudgeResult {
  ran: boolean;
  ok: boolean | null;
  skipped?: boolean;
  reason?: string;
}

export interface VerifyResult {
  ran: boolean;
  ok: boolean;
  detail?: string;
}

export interface ScenarioReport {
  schema: 'callsim.report/1';
  runId: string;
  scenario: string;
  file: string;
  transport: string;
  room?: string;
  agent?: { identity: string; joinedMs: number };
  caller?: { identity: string; kind: string; requestedKind: string };
  ok: boolean;
  failures: string[];
  warnings: string[];
  turns: ReportTurn[];
  bargeIn: ReportBargeIn[];
  dtmf: ReportDtmf[];
  latency?: { firstAudioMs: { p50: number; p95: number; max: number } };
  judge?: JudgeResult;
  verify?: VerifyResult;
  transcript: ReportTranscriptLine[];
  artifacts: { wav?: string; events?: string };
  versions: { callsim: string; rtcNode?: string };
  durationMs?: number;
  error?: { code: string; message: string; exitCode: 1 | 2 };
}
