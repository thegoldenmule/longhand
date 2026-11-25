/**
 * Small process helpers for the root `dev` and `e2e` scripts: prefixed output,
 * process-group signalling (so `pnpm → tsx → node` trees stop together) and
 * port checks.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';

const COLORS = [36, 35, 33, 32, 34, 31];
let colorIndex = 0;

/** Starts a command in its own process group, prefixing each output line. */
export function run(
  name: string,
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): ChildProcess {
  const color = COLORS[colorIndex++ % COLORS.length] as number;
  const tag = process.stdout.isTTY ? `\x1b[${color}m[${name}]\x1b[0m` : `[${name}]`;
  const child = spawn(command, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, FORCE_COLOR: process.stdout.isTTY ? '1' : '0', ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const pipe = (stream: NodeJS.ReadableStream | null, out: NodeJS.WriteStream) => {
    let buf = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(`${tag} ${l}\n`);
    });
    stream?.on('end', () => buf && out.write(`${tag} ${buf}\n`));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
}

/** Sends a signal to a child's whole process group. */
export function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}

/** Resolves with the exit code (or 1 for a signal). */
export function exited(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code ?? 1));
  });
}

/** True when something accepts TCP connections on the port. */
export function portInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
