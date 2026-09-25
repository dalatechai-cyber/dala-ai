/**
 * The founder's emergency override for the reply-case gate (D-121). Run on YOUR machine.
 *
 * Once, to create your key (the private key stays in the file; nothing is sent anywhere):
 *
 *     node scripts/replycases/override.ts keygen
 *
 * It writes `~/.dala/gate-override.key` (mode 0600) and prints the PUBLIC key. That public
 * key goes into `src/lib/replycases/overrideKeys.ts`, by your own commit or by asking for it.
 *
 * In an emergency (the database or Anthropic is down and a hotfix must deploy):
 *
 *     node scripts/replycases/override.ts sign --sha <40-hex commit> --reason "Supabase down; hotfix for …" [--hours 6]
 *
 * It prints a token. Put it in Vercel → Settings → Environment Variables as
 * `REPLY_GATE_OVERRIDE` (Production), then redeploy that commit. The token works for that
 * one commit only and expires within 24 hours. Using it sends you a Telegram alert, and if
 * the alert cannot be sent it does not work. It never lets a case through that was checked
 * and answered wrongly, only cases that could not be checked. Remove the variable afterwards.
 * It is inert for any other commit, but nothing should sit in the environment unexplained.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateOverrideKey, keyId, signOverride } from '../../src/lib/replycases/override.ts';

function die(message: string): never {
  process.stderr.write(`override: ${message}\n`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const keyPath = arg('key') ?? join(homedir(), '.dala', 'gate-override.key');
const command = process.argv[2];

if (command === 'keygen') {
  // Never overwrite: a second keygen would silently orphan the key already registered.
  if (existsSync(keyPath)) die(`${keyPath} already exists. Use --key <path> for a new one.`);
  const { publicKey, privateKeyPem } = generateOverrideKey();
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`private key written to ${keyPath} (mode 0600). Keep it there; never share it.\n\n`
    + `public key (key ${keyId(publicKey)}), for src/lib/replycases/overrideKeys.ts:\n${publicKey}\n`);
} else if (command === 'sign') {
  if (!existsSync(keyPath)) die(`no key at ${keyPath}. Run: node scripts/replycases/override.ts keygen`);
  const sha = arg('sha') ?? '';
  const reason = arg('reason') ?? '';
  const hours = Number(arg('hours') ?? '6');
  let token: string;
  try {
    token = signOverride({ sha, reason, now: new Date(), hours }, readFileSync(keyPath, 'utf8'));
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  process.stdout.write(`REPLY_GATE_OVERRIDE for commit ${sha.slice(0, 7)}, valid ${hours}h:\n${token}\n`);
} else {
  die('usage: override.ts keygen [--key <path>] | sign --sha <40-hex> --reason "<why>" [--hours <1-24>] [--key <path>]');
}
