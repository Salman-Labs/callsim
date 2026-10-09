import { validateScenarioFile } from './scenario/validate.js';

interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function runValidateCommand(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(validateHelp());
    return 0;
  }
  const file = argv.find((arg) => !arg.startsWith('--'));
  if (!file || argv.length !== 1) {
    io.stderr(`Expected one scenario file.\n\n${validateHelp()}`);
    return 2;
  }
  const result = validateScenarioFile(file);
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 2;
}

function validateHelp(): string {
  return `callsim validate <file> — check a scenario without placing a call

Missing environment variables are printed by name. Values are never printed.
Exit 0 when the file is valid and every referenced variable is set. Exit 2 otherwise.

callsim is not affiliated with Twilio or LiveKit.
`;
}
