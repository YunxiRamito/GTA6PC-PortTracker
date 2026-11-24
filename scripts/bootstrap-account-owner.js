'use strict';

const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { createAdminAccounts } = require('../api/_admin-accounts');

const USAGE = `Usage:
  node scripts/bootstrap-account-owner.js <username>

Reads the owner password from stdin without echo. Set GTAVI_RUNTIME_DIR to use a different local runtime directory.`;

function writeUsage(stream) {
  stream.write(`${USAGE}\n`);
}

function removeInputLineEnding(value) {
  return value.replace(/(?:\r\n|\n|\r)$/, '');
}

async function readPipedPassword() {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) value += chunk;
  return removeInputLineEnding(value);
}

function readTerminalPassword() {
  const input = process.stdin;
  if (typeof input.setRawMode !== 'function') throw new Error('terminal input unavailable');

  const decoder = new StringDecoder('utf8');
  const wasRaw = input.isRaw;
  let password = '';

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write('\n');
    };
    const finish = (error, value) => {
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onError = () => finish(new Error('terminal input unavailable'));
    const onData = chunk => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003' || character === '\u0004') {
          finish(new Error('input cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish(null, password);
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          password = Array.from(password).slice(0, -1).join('');
        } else if (character === '\u0015') {
          password = '';
        } else if (character !== '\u001b') {
          password += character;
        }
      }
    };

    input.on('data', onData);
    input.on('error', onError);
    input.setRawMode(true);
    input.resume();
  });
}

async function readPassword() {
  if (!process.stdin.isTTY) return readPipedPassword();
  process.stderr.write('Password: ');
  return readTerminalPassword();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    writeUsage(process.stdout);
    return;
  }
  if (args.length !== 1) {
    writeUsage(process.stderr);
    process.exitCode = 1;
    return;
  }

  const directory = path.resolve(process.env.GTAVI_RUNTIME_DIR || path.join(__dirname, '../.runtime'));
  const filePath = path.join(directory, 'accounts.json');
  if (require('node:fs').existsSync(filePath)) {
    process.stderr.write('The local accounts store already exists.\n');
    process.exitCode = 1;
    return;
  }

  let password = '';
  try {
    password = await readPassword();
    const accounts = createAdminAccounts({
      filePath,
      bootstrap: { username: args[0], password },
      confirmedInitialOwner: args[0],
    });
    await accounts.initialize();
    process.stdout.write('Account owner provisioned successfully.\n');
  } catch {
    process.stderr.write('Unable to provision account owner.\n');
    process.exitCode = 1;
  } finally {
    password = '';
  }
}

main().catch(() => {
  process.stderr.write('Unable to provision account owner.\n');
  process.exitCode = 1;
});
