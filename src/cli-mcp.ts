interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function runMcpCommand(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(mcpHelp());
    return 0;
  }
  if (argv.length > 0) {
    io.stderr(`Unknown option ${argv[0]}.\n\n${mcpHelp()}`);
    return 2;
  }
  const { startMcpStdio } = await import('./mcp/server.js');
  await startMcpStdio();
  return 0;
}

function mcpHelp(): string {
  return `callsim mcp — stdio MCP server for scripted voice-agent tests

Usage:
  callsim mcp
  npx -y voice-callsim mcp

Tools: list_scenarios, validate_scenario, run_scenario, get_report, list_runs, compare_runs.
run_scenario is not read-only. It can spend the agent under test its own model and speech calls.
One run at a time unless CALLSIM_MAX_RUNS is set. API keys are never returned.

callsim is not affiliated with Twilio or LiveKit.
`;
}
