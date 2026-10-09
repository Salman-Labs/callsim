import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

/** Pinned to the release exercised by the LiveKit transport probe. */
export const LIVEKIT_SERVER_PIN = {
  version: '1.13.9',
  archive: 'livekit_1.13.9_linux_amd64.tar.gz',
  sha256: '0b7fa208b662d09cfdeae8c06cf4c481aead0556086558b48250501e2e2d6e20',
  url: 'https://github.com/livekit/livekit/releases/download/v1.13.9/livekit_1.13.9_linux_amd64.tar.gz',
} as const;

const BIN_DIR = join(process.cwd(), '.callsim', 'bin');

export async function ensureLiveKitServer(): Promise<string> {
  if (process.arch !== 'x64' || process.platform !== 'linux') {
    throw new Error(
      `livekit-server ${LIVEKIT_SERVER_PIN.version} pin is the linux amd64 archive; this host is ${process.platform} ${process.arch}`,
    );
  }
  mkdirSync(BIN_DIR, { recursive: true });
  const archivePath = join(BIN_DIR, LIVEKIT_SERVER_PIN.archive);
  const binary = join(BIN_DIR, 'livekit-server');
  if (!existsSync(archivePath) || sha256(readFileSync(archivePath)) !== LIVEKIT_SERVER_PIN.sha256) {
    const response = await fetch(LIVEKIT_SERVER_PIN.url);
    if (!response.ok) throw new Error(`Could not download livekit-server ${LIVEKIT_SERVER_PIN.version}: HTTP ${response.status}`);
    writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
  }
  const actual = sha256(readFileSync(archivePath));
  if (actual !== LIVEKIT_SERVER_PIN.sha256) {
    throw new Error(`livekit-server checksum mismatch: expected ${LIVEKIT_SERVER_PIN.sha256}, got ${actual}`);
  }
  if (!existsSync(binary)) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('tar', ['-xzf', archivePath, '-C', BIN_DIR], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    });
  }
  return binary;
}

export interface LiveKitDevServer {
  url: string;
  apiKey: string;
  apiSecret: string;
  stop(): Promise<void>;
}

export async function startLiveKitDev(): Promise<LiveKitDevServer> {
  const binary = await ensureLiveKitServer();
  const child = spawn(binary, ['--dev'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const capture = (chunk: Buffer): void => {
    logs = `${logs}${chunk.toString()}`.slice(-4000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  try {
    await waitForPort(7880, 20_000, child);
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${logs}`);
  }
  return {
    url: 'ws://127.0.0.1:7880',
    apiKey: 'devkey',
    apiSecret: 'secret',
    stop: () => stopChild(child),
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function waitForPort(port: number, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (child.exitCode !== null) {
        reject(new Error(`livekit-server exited ${child.exitCode} before port ${port} opened`));
        return;
      }
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`livekit-server did not listen on ${port}`));
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
