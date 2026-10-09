import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runScenarios } from '../scenario/run.js';
import { scrubSecrets } from '../scenario/errors.js';
import { packageVersion } from '../version.js';
import { beginRun, endRun, RUN_BUSY } from './lock.js';
import {
  agentJson,
  compareReports,
  listScenarioCatalog,
  listStoredRuns,
  readRunEvents,
  readRunReport,
  compactReport,
  validateForAgent,
} from './report.js';

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const runAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

export function createCallsimMcpServer(): McpServer {
  const server = new McpServer({ name: 'callsim', version: packageVersion() });

  server.registerTool(
    'list_scenarios',
    {
      description: 'List callsim scenario files, labels, tags, and transport. Does not run a call and does not return secret values.',
      inputSchema: { glob: z.string().optional().describe('Optional glob, relative to the working directory.') },
      annotations: readOnly,
    },
    async ({ glob }) => agentJson(listScenarioCatalog(glob, process.cwd())),
  );

  server.registerTool(
    'validate_scenario',
    {
      description:
        'Check a scenario file. Missing environment variables are reported by name only. Secret values are never returned.',
      inputSchema: { file: z.string().describe('Scenario YAML path.') },
      annotations: readOnly,
    },
    async ({ file }) => agentJson(validateForAgent(file, process.cwd())),
  );

  server.registerTool(
    'run_scenario',
    {
      description:
        'Run one scenario file as a scripted caller. Returns a compact summary and runId. Spends the agent under test its own STT, LLM, and TTS. One run at a time by default. Does not return API keys.',
      inputSchema: {
        file: z.string().describe('Scenario YAML path.'),
        label: z.string().optional().describe('Run only the scenario with this label.'),
        tags: z.record(z.string()).optional().describe('Run scenarios that include every tag.'),
        timeoutSec: z.number().positive().max(600).optional().describe('Whole-scenario limit in seconds.'),
      },
      annotations: runAnnotations,
    },
    async ({ file, label, tags, timeoutSec }) => {
      if (!beginRun()) return agentJson({ ok: false, error: RUN_BUSY }, true);
      try {
        const reports = await runScenarios({
          files: [file],
          cwd: process.cwd(),
          ...(label ? { labels: [label] } : {}),
          ...(tags && Object.keys(tags).length > 0 ? { tags } : {}),
          ...(timeoutSec !== undefined ? { timeoutMs: timeoutSec * 1000 } : {}),
        });
        const runs = reports.map((report) => compactReport(report));
        const first = runs[0];
        return agentJson({
          ok: runs.every((run) => run.ok),
          ...(first ? { runId: first.runId } : {}),
          runs,
        });
      } catch (err) {
        return agentJson({ ok: false, error: scrubSecrets(err instanceof Error ? err.message : String(err)) }, true);
      } finally {
        endRun();
      }
    },
  );

  server.registerTool(
    'get_report',
    {
      description: 'Read a stored callsim run. Turns, transcript, and events are omitted unless include asks for them. Does not return secret values.',
      inputSchema: {
        runId: z.string().describe('Run id returned by run_scenario.'),
        include: z.array(z.enum(['turns', 'transcript', 'events'])).optional().describe('Extra sections to include.'),
      },
      annotations: readOnly,
    },
    async ({ runId, include }) => {
      try {
        const report = readRunReport(runId, process.cwd());
        const wanted = new Set(include ?? []);
        return agentJson({
          ...compactReport(report),
          ...(wanted.has('turns') ? { turns: report.turns } : {}),
          ...(wanted.has('transcript') ? { transcript: report.transcript } : {}),
          ...(wanted.has('events') ? { events: readRunEvents(runId, process.cwd()) } : {}),
        });
      } catch (err) {
        return agentJson({ ok: false, error: scrubSecrets(err instanceof Error ? err.message : String(err)) }, true);
      }
    },
  );

  server.registerTool(
    'list_runs',
    {
      description: 'List recent callsim runs with ok or fail. Does not return secret values.',
      inputSchema: { limit: z.number().int().positive().max(100).optional().describe('How many runs to return. Default 20.') },
      annotations: readOnly,
    },
    async ({ limit }) => agentJson({ runs: listStoredRuns(limit ?? 20, process.cwd()) }),
  );

  server.registerTool(
    'compare_runs',
    {
      description: 'Compare latency and check results between two stored runs. Does not return secret values.',
      inputSchema: {
        base: z.string().describe('Baseline run id.'),
        head: z.string().describe('Run id to compare against the baseline.'),
      },
      annotations: readOnly,
    },
    async ({ base, head }) => {
      try {
        return agentJson(compareReports(readRunReport(base, process.cwd()), readRunReport(head, process.cwd())));
      } catch (err) {
        return agentJson({ ok: false, error: scrubSecrets(err instanceof Error ? err.message : String(err)) }, true);
      }
    },
  );

  return server;
}

export async function startMcpStdio(): Promise<void> {
  const server = createCallsimMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    transport.onclose = done;
    process.stdin.once('end', done);
  });
}
