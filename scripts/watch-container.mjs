import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { channelTarget } from '../containers/watch-together/automation-config.mjs';

const file = fileURLToPath(new URL('../containers/watch-together/compose.yaml', import.meta.url));
const mode = process.argv[2] || 'start';
const commands = { start: ['up', '-d', '--build', '--wait'], stop: ['stop'], status: ['ps'], logs: ['logs', '--tail', '80'] };
if (mode === 'automate') {
  try { commands.automate = ['exec', '-T', 'companion', 'node', '/opt/companion/automation-config.mjs', 'enable', channelTarget(process.argv[3]).channelUrl, process.argv[4] || '']; }
  catch { console.error('Use automate https://discord.com/channels/SERVER_ID/VOICE_CHANNEL_ID [NAME]'); process.exit(1); }
}
commands['automation-off'] = ['exec', '-T', 'companion', 'node', '/opt/companion/automation-config.mjs', 'disable'];
commands['automation-status'] = ['exec', '-T', 'companion', 'node', '/opt/companion/automation-config.mjs', 'status'];
if (!commands[mode]) { console.error('Use start | stop | status | logs | automate CHANNEL_URL [NAME] | automation-off | automation-status'); process.exit(1); }
const local = process.env.TORII_LOCAL_URL || `http://127.0.0.1:${process.env.TORII_PORT || 3939}`;
const companionUrl = process.env.TORII_COMPANION_URL || `http://host.docker.internal:${new URL(local).port || 3939}`;
let token = 'unused-for-management';
if (mode === 'start') {
  try {
    const res = await fetch(new URL('/api/watch-together/container-token', local), { method: 'POST', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('Restart Torii with the Watch Together update first.');
    token = (await res.json()).token;
    if (!token) throw new Error('Torii did not return a companion token.');
  } catch (err) { console.error(err.message); process.exit(1); }
}
const child = spawn('docker', ['compose', '-f', file, ...commands[mode]], {
  stdio: 'inherit', env: { ...process.env, TORII_WATCH_TOKEN: token, TORII_COMPANION_URL: companionUrl },
});
child.on('error', () => { console.error('Install and start Docker Desktop first.'); process.exitCode = 1; });
child.on('exit', code => {
  process.exitCode = code || 0;
  if (!code && mode === 'start') console.log('Isolated desktop: http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale\nSelect your Plex TV in Torii → Setup → Watch together, then sign into the separate Discord account inside this desktop.\nEnable saved channel automation with: npm run watch-together:container -- automate CHANNEL_URL [NAME]\nWithout automation, share the Torii Watch Together browser TAB with tab audio.');
});
