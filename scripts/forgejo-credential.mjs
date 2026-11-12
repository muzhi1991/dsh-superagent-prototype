#!/usr/bin/env node
// Git invokes this with <private-file> get. Never print credentials for another origin.
import { readFileSync, statSync } from 'node:fs';
const [file, operation] = process.argv.slice(2);
if (operation === 'get') {
  if (statSync(file).mode & 0o077) throw new Error('Credentials file must have mode 0600');
  const account = JSON.parse(readFileSync(file, 'utf8'));
  const input = Object.fromEntries(readFileSync(0, 'utf8').trim().split('\n').map(line => { const i=line.indexOf('='); return [line.slice(0,i), line.slice(i+1)] }));
  const origin = new URL(account.url);
  if (input.protocol === origin.protocol.slice(0,-1) && input.host === origin.host) {
    process.stdout.write(`username=${account.login}\npassword=${account.token}\n\n`);
  }
}
