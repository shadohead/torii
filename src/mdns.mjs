import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { log } from './log.mjs';

export const LOCAL_HOSTNAME = 'torii.local';

function lanAddress() {
  return Object.entries(networkInterfaces())
    .flatMap(([name, addresses]) => (addresses || []).map(address => ({ name, ...address })))
    .filter(address => address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))
    .sort((a, b) => {
      // Prefer ordinary Mac network interfaces over VPNs and virtual bridges.
      const score = ({ name }) => /^en\d+$/.test(name) ? 0 : /^(eth|wlan)\d+$/.test(name) ? 1 : 2;
      return score(a) - score(b);
    })[0]?.address || null;
}

// Publish a real multicast-DNS hostname, not just a discoverable service name.
// macOS ships dns-sd as part of Bonjour, so this adds no daemon or dependency.
export function publishLocalHostname(port) {
  if (process.platform !== 'darwin') return () => {};

  let child = null;
  let address = null;
  let stopped = false;
  let retry = null;

  const stopChild = () => {
    const current = child;
    child = null;
    if (current) current.kill('SIGTERM');
  };

  const schedule = () => {
    clearTimeout(retry);
    retry = setTimeout(refresh, 5000);
    retry.unref();
  };

  const refresh = () => {
    if (stopped) return;
    const nextAddress = lanAddress();
    if (!nextAddress) {
      stopChild();
      address = null;
      schedule();
      return;
    }
    if (child && nextAddress === address) return;

    stopChild();
    address = nextAddress;
    const publisher = spawn('/usr/bin/dns-sd', [
      '-P', 'Torii', '_http._tcp', 'local.', String(port), LOCAL_HOSTNAME, address, 'path=/',
    ], { stdio: 'ignore' });
    child = publisher;
    publisher.once('error', (err) => {
      log.warn(`could not publish ${LOCAL_HOSTNAME}: ${err.message}`);
      if (child === publisher) {
        child = null;
        schedule();
      }
    });
    publisher.once('exit', () => {
      if (child === publisher) {
        child = null;
        if (!stopped) schedule();
      }
    });
    log(`bonjour: http://${LOCAL_HOSTNAME}${port === 80 ? '' : `:${port}`} -> ${address}:${port}`);
  };

  refresh();
  const networkTimer = setInterval(refresh, 30000);
  networkTimer.unref();

  return () => {
    stopped = true;
    clearInterval(networkTimer);
    clearTimeout(retry);
    stopChild();
  };
}
