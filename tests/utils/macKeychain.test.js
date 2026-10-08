/**
 * macKeychain: the CLI's Keychain items, reached through /usr/bin/security.
 *
 * The regression behind it: the app read those items in-process with keytar,
 * which made the app the requester. It is not on their access list (the CLI
 * created them through `security`), and an ad-hoc signed build changes code
 * signature on every update, so macOS asked for the login password after each
 * release, once per item, every time the credential watch came round.
 *
 * child_process is mocked: the real binary would read and write the
 * developer's login keychain.
 */

jest.mock('child_process', () => ({ execFile: jest.fn() }));

const { execFile } = require('child_process');
const keychain = require('../../src/main/utils/macKeychain');

const SERVICE = 'Claude Code-credentials';
const ACCOUNT = 'someone';

const hex = (text) => Buffer.from(text, 'utf8').toString('hex');

/** Answer the next `security` call: exit code, stdout, captured stdin. */
function answer({ code = 0, stdout = '' } = {}) {
  const call = { stdin: '' };
  execFile.mockImplementationOnce((file, args, opts, cb) => {
    call.file = file;
    call.args = args;
    Promise.resolve().then(() => {
      if (code === 0) cb(null, stdout, '');
      else cb(Object.assign(new Error(`security exited with ${code}`), { code }), '', '');
    });
    return { stdin: { end: (data) => { call.stdin = data ?? ''; } } };
  });
  return call;
}

beforeEach(() => execFile.mockReset());

describe('getPassword', () => {
  test('asks /usr/bin/security, the binary the CLI created the item with', async () => {
    const call = answer({ stdout: '{"claudeAiOauth":{}}\n' });

    expect(await keychain.getPassword(SERVICE, ACCOUNT)).toBe('{"claudeAiOauth":{}}');
    expect(call.file).toBe('/usr/bin/security');
    expect(call.args).toEqual(['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w']);
  });

  test('decodes the hex form security prints for a payload with newlines', async () => {
    const pretty = JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }, null, 2);
    answer({ stdout: `${hex(pretty)}\n` });

    expect(await keychain.getPassword(SERVICE, ACCOUNT)).toBe(pretty);
  });

  test('decodes non-ASCII text, which security also prints as hex', async () => {
    const payload = '{"name":"Zoë"}';
    answer({ stdout: `${hex(payload)}\n` });

    expect(await keychain.getPassword(SERVICE, ACCOUNT)).toBe(payload);
  });

  test('leaves a printable value that merely looks like hex alone', async () => {
    answer({ stdout: 'deadbeef\n' });
    expect(await keychain.getPassword(SERVICE, ACCOUNT)).toBe('deadbeef');

    answer({ stdout: '41424344\n' });
    expect(await keychain.getPassword(SERVICE, ACCOUNT)).toBe('41424344');
  });

  test('a missing item is null, not an error', async () => {
    answer({ code: 44 });
    expect(await keychain.getPassword(SERVICE, ACCOUNT)).toBeNull();
  });

  test('any other failure is thrown, so callers can tell absent from unreadable', async () => {
    answer({ code: 36 });
    await expect(keychain.getPassword(SERVICE, ACCOUNT)).rejects.toThrow();
  });
});

describe('setPassword', () => {
  test('updates in place over stdin, so the secret never reaches argv', async () => {
    const secret = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-secret"}}';
    const call = answer();

    await keychain.setPassword(SERVICE, ACCOUNT, secret);

    expect(call.args).toEqual(['-i']);
    expect(call.stdin).toBe(`add-generic-password -U -a "${ACCOUNT}" -s "${SERVICE}" -X "${hex(secret)}"\n`);
    expect(call.args.join(' ')).not.toContain('sk-ant');
  });

  test('falls back to argv past the interactive line limit, as the CLI does', async () => {
    const secret = JSON.stringify({ mcpOAuth: { blob: 'x'.repeat(3000) } });
    const call = answer();

    await keychain.setPassword(SERVICE, ACCOUNT, secret);

    expect(call.args).toEqual(['add-generic-password', '-U', '-a', ACCOUNT, '-s', SERVICE, '-X', hex(secret)]);
  });

  test('refuses a name that would break out of the quoted command line', async () => {
    await expect(keychain.setPassword('evil" -T "/bin/sh', ACCOUNT, 'x')).rejects.toThrow();
    expect(execFile).not.toHaveBeenCalled();
  });

  test('a failed write is thrown', async () => {
    answer({ code: 45 });
    await expect(keychain.setPassword(SERVICE, ACCOUNT, 'x')).rejects.toThrow();
  });
});

describe('deletePassword', () => {
  test('deletes through security', async () => {
    const call = answer();
    expect(await keychain.deletePassword(SERVICE, ACCOUNT)).toBe(true);
    expect(call.args).toEqual(['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE]);
  });

  test('nothing to delete is false, not an error', async () => {
    answer({ code: 44 });
    expect(await keychain.deletePassword(SERVICE, ACCOUNT)).toBe(false);
  });
});
