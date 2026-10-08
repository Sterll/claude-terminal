/**
 * The macOS login Keychain, reached the way the Claude CLI reaches it.
 *
 * The CLI reads and writes its credential items through /usr/bin/security, so
 * that binary is the application every item's access list trusts. Reading the
 * same items in-process (keytar, i.e. the Security framework inside Electron)
 * makes this app the requester instead, and it is not on that list: macOS asks
 * for the login password. "Always Allow" does not hold either. It pins the
 * app's code signature, and an ad-hoc signed build gets a new one with every
 * update, so each release brought the dialog back once per item, every five
 * minutes, for as long as it went unanswered.
 *
 * Going through the same binary as the CLI makes these reads silent whatever
 * the app is signed with. Same surface as keytar (getPassword / setPassword /
 * deletePassword), so callers and their test doubles do not change shape.
 *
 * This is for items the CLI owns. The app's own secrets (GitHub token, Groq key)
 * stay on keytar: the app created them, so it is on their access list, and
 * only a stable signing identity would keep it there across updates.
 */

const { execFile } = require('child_process');
const { TextDecoder } = require('util');

const SECURITY = '/usr/bin/security';

// Long enough to type a password into the unlock dialog a locked keychain
// raises, bounded so a wedged child cannot hold a read open forever.
const TIMEOUT_MS = 60 * 1000;

// `security` exits with the low byte of the OSStatus.
const ITEM_NOT_FOUND = 44; // errSecItemNotFound

// `security -i` reads one command per line into a fixed buffer. The CLI keeps
// its lines under this and falls back to argv past it; so does this module.
const INTERACTIVE_LINE_MAX = 4032;

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(SECURITY, args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
    // A child that exits before reading stdin makes the write fail with EPIPE.
    // Unheard, that error is an uncaught exception in main; the exit code
    // already reaches the callback above, so there is nothing to add here.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * `find-generic-password -w` prints the data as-is when every byte is
 * printable ASCII, and as hex otherwise. The payloads here are JSON, and
 * pretty-printed JSON carries newlines, so both forms come back. The hex form
 * is recognised by the condition that produced it: decoded, it is text holding
 * a byte that would not have been printed as-is. Only a stored value made of
 * hex digits alone could be misread, and a JSON payload never is one.
 * @param {string} printed
 * @returns {string}
 */
function decodePrinted(printed) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(printed)) return printed;
  const bytes = Buffer.from(printed, 'hex');
  if (bytes.every(b => b >= 0x20 && b < 0x7f)) return printed;
  try {
    return utf8.decode(bytes);
  } catch {
    return printed;
  }
}

/**
 * @param {string} service
 * @param {string} account
 * @returns {Promise<string|null>} null when there is no such item
 */
async function getPassword(service, account) {
  try {
    const out = await run(['find-generic-password', '-a', account, '-s', service, '-w']);
    return decodePrinted(out.replace(/\n$/, ''));
  } catch (err) {
    if (err.code === ITEM_NOT_FOUND) return null;
    throw err;
  }
}

/**
 * Create the item, or update it in place: `-U` keeps an existing item's access
 * list, which is what lets the CLI keep reading it without a dialog.
 * @param {string} service
 * @param {string} account
 * @param {string} secret
 */
async function setPassword(service, account, secret) {
  // The names go on a quoted `-i` line: refuse anything the line splitter could
  // read as a quote, an escape or a line end rather than trust it to agree.
  if (/["'\\\x00-\x1f\x7f]/.test(service + account)) throw new Error('Unsupported Keychain service or account name');
  const hex = Buffer.from(secret, 'utf8').toString('hex');
  // Over stdin rather than argv, so the secret never shows up in `ps`.
  const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
  if (line.length <= INTERACTIVE_LINE_MAX) {
    await run(['-i'], line);
  } else {
    await run(['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex]);
  }
}

/**
 * @param {string} service
 * @param {string} account
 * @returns {Promise<boolean>} false when there was nothing to delete
 */
async function deletePassword(service, account) {
  try {
    await run(['delete-generic-password', '-a', account, '-s', service]);
    return true;
  } catch (err) {
    if (err.code === ITEM_NOT_FOUND) return false;
    throw err;
  }
}

module.exports = { getPassword, setPassword, deletePassword, decodePrinted };
