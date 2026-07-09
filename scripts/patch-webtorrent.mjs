// Guards two race conditions in webtorrent 3.x where torrent.pieces[i] is nulled
// (piece verified) a beat before the bitfield bit is set, crashing hot-path getters
// and piece selection mid-download. Idempotent; runs on postinstall.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../node_modules/webtorrent/lib/torrent.js', import.meta.url);
let src = readFileSync(file, 'utf8');
const before = src;

src = src.replace(
  `        const piece = this.pieces[index]
        downloaded += (piece.length - piece.missing)`,
  `        const piece = this.pieces[index]
        if (piece) downloaded += (piece.length - piece.missing) // torii: null-guard verified-piece race`
);

src = src.replace(
  `        let missing = self.pieces[index].missing`,
  `        const _piece = self.pieces[index]
        if (!_piece) return true // torii: null-guard verified-piece race
        let missing = _piece.missing`
);

src = src.replace(
  `    const piece = self.pieces[index]
    let reservation = isWebSeed ? piece.reserveRemaining() : piece.reserve()`,
  `    const piece = self.pieces[index]
    if (!piece) return false // torii: null-guard verified-piece race
    let reservation = isWebSeed ? piece.reserveRemaining() : piece.reserve()`
);

if (src !== before) {
  writeFileSync(file, src);
  console.log('webtorrent patched');
} else {
  console.log(src.includes('torii: null-guard') ? 'webtorrent already patched' : 'WARNING: patterns not found - webtorrent version changed?');
}
