// Manage the Torii background service (macOS launchd) from the command line.
//   node scripts/service.mjs install     - install + start the login item
//   node scripts/service.mjs uninstall   - stop + remove it
//   node scripts/service.mjs status      - show whether it is installed/loaded
import { enableLoginItem, disableLoginItem, loginItemStatus } from '../src/system.mjs';

if (process.platform !== 'darwin') {
  console.log('The managed service uses launchd and is macOS-only.');
  console.log('On other platforms run `npm start` under your own supervisor (systemd, pm2, ...).');
  process.exit(1);
}

const cmd = process.argv[2] || 'status';
const actions = { install: enableLoginItem, uninstall: disableLoginItem, status: loginItemStatus };
if (!actions[cmd]) {
  console.error(`unknown command "${cmd}" - use install | uninstall | status`);
  process.exit(1);
}
const s = await actions[cmd]();
console.log(`service ${cmd}: installed=${s.installed} loaded=${s.loaded}`);
