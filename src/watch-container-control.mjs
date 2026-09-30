import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const composeFile = fileURLToPath(new URL('../containers/watch-together/compose.yaml', import.meta.url));

export function containerStarter({ run = promisify(execFile), env = process.env } = {}) {
  let pending;
  return (token, port) => {
    if (pending) return pending;
    pending = run('docker', ['compose', '-f', composeFile, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '30'], {
      timeout: 45000, maxBuffer: 64 * 1024,
      env: { ...env, TORII_WATCH_TOKEN: token, TORII_COMPANION_URL: env.TORII_COMPANION_URL || `http://host.docker.internal:${port}` },
    }).catch(() => {
      // Docker output can contain environment values; keep errors safe for LAN clients.
      throw Object.assign(new Error('Could not start the companion. Open Docker Desktop on the server. If this is the first setup, install the companion from Setup first.'), { status: 503 });
    }).finally(() => { pending = null; });
    return pending;
  };
}
