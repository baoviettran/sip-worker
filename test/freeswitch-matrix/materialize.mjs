// test/freeswitch-matrix/materialize.mjs
// Regenerates test/freeswitch-matrix/fs-conf/ from the pinned FreeSWITCH image's
// vanilla conf template (v1.10.12). Run ONLY when bumping the image pin or after
// an overlay edit:   node test/freeswitch-matrix/materialize.mjs
// The committed fs-conf/ tree is the source of truth for CI.
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FS_IMAGE =
  'safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6';
const VANILLA = '/usr/share/freeswitch/conf/vanilla';
const matrixDir = fileURLToPath(new URL('.', import.meta.url));
const confDir = join(matrixDir, 'fs-conf');
const overlayDir = join(matrixDir, 'fs-conf.overlay');

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'] }).trim();
}

export function materializeConf() {
  rmSync(confDir, { recursive: true, force: true });
  mkdirSync(confDir, { recursive: true });
  // 1) copy the vanilla template out of the pinned image
  const cid = docker('create', FS_IMAGE);
  try {
    docker('cp', `${cid}:${VANILLA}/.`, confDir);
  } finally {
    docker('rm', cid);
  }
  // 2) strip trees the matrix harness does not need (boot validated without them)
  for (const dir of ['lang', 'ivr_menus', 'chatplan', 'skinny_profiles', 'yaml']) {
    rmSync(join(confDir, dir), { recursive: true, force: true });
  }
  for (const f of [
    'tetris.ttml', 'fur_elise.ttml', 'vars.xml.orig',
    'config.FS0', 'extensions.conf', 'notify-voicemail.tpl',
    'README_IMPORTANT.txt', 'voicemail.tpl', 'web-vm.tpl', 'mime.types',
  ]) {
    rmSync(join(confDir, f), { force: true });
  }
  // 3) drop every vanilla sip profile FILE; the external/ + external-ipv6/
  //    template dirs stay (the validated 43-file tree keeps them; nothing loads
  //    them once the profile files are gone)
  for (const f of ['internal.xml', 'internal-ipv6.xml', 'external.xml', 'external-ipv6.xml']) {
    rmSync(join(confDir, 'sip_profiles', f), { force: true });
  }
  // 4) prune the directory to user 1000, keeping the default.xml include pointer
  for (const f of readdirSync(join(confDir, 'directory', 'default'))) {
    if (f !== '1000.xml' && f !== 'default.xml') {
      rmSync(join(confDir, 'directory', 'default', f), { recursive: true, force: true });
    }
  }
  // 5) prune autoload_configs to the conf files of the 9 loaded modules
  const keepAutoload = new Set([
    'console.conf.xml', 'db.conf.xml', 'event_socket.conf.xml', 'logfile.conf.xml',
    'modules.conf.xml', 'opus.conf.xml', 'sofia.conf.xml', 'switch.conf.xml',
  ]);
  for (const f of readdirSync(join(confDir, 'autoload_configs'))) {
    if (!keepAutoload.has(f)) rmSync(join(confDir, 'autoload_configs', f), { recursive: true, force: true });
  }
  // 6) merge the committed overlays over the pruned tree — overlay files
  //    overwrite their vanilla paths; the rest of the vanilla tree stays (the
  //    validated tree keeps dialplan/features.xml, public.xml, skinny-patterns
  //    and the default/ demo subdir, which freeswitch.xml includes)
  cpSync(overlayDir, confDir, { recursive: true, force: true });
  // 7) in-place edits
  editFreeswitchXml(); // drop the chatplan/lang include lines (their trees were pruned)
  editVars();          // fixed default_password, loopback domain, recordings_dir
  mkdirSync(join(confDir, 'tls'), { recursive: true }); // certs minted per run, never committed
}

function editFreeswitchXml() {
  const p = join(confDir, 'freeswitch.xml');
  const keep = readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => !/data="(?:chatplan\/\*|lang\/)/.test(l));
  writeFileSync(p, keep.join('\n'));
}

function editVars() {
  const p = join(confDir, 'vars.xml');
  const s = readFileSync(p, 'utf8')
    .replace(/<X-PRE-PROCESS cmd="set" data="default_password=[^"]*"/, '<X-PRE-PROCESS cmd="set" data="default_password=matrix-pass-2026"')
    .replace(/data="domain=[^"]*"/, 'data="domain=127.0.0.1"')
    .replace(/<X-PRE-PROCESS cmd="set" data="domain=127\.0\.0\.1"\/>/, '<X-PRE-PROCESS cmd="set" data="domain=127.0.0.1"/>\n  <X-PRE-PROCESS cmd="set" data="recordings_dir=/recordings"/>');
  writeFileSync(p, s);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) materializeConf();
