import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SubprocessResult {
  stdout: string;
  stderr: string;
}

export async function runCommand(
  cmd: string,
  args: string[],
  options?: { timeout?: number; cwd?: string }
): Promise<SubprocessResult> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: options?.timeout ?? 60_000,
    cwd: options?.cwd,
    maxBuffer: 50 * 1024 * 1024, // 50MB
  });
  return { stdout, stderr };
}
