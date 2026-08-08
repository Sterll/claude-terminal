/**
 * TerminalOutputCapture — the writer for ~/.claude-terminal/terminals/output.
 *
 * That path was read by the MCP `terminal_read_output` tool and the `terminal`
 * workflow node long before anything wrote it, so both always came back empty.
 */

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}), { virtual: true });

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Point the data dir at a throwaway home BEFORE the module resolves its paths.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tcap-'));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME        = FAKE_HOME;

const capture = require('../../src/main/services/TerminalOutputCapture');

const readLog = (projectId) => {
  try { return fs.readFileSync(capture.logFileFor(projectId), 'utf8'); }
  catch { return null; }
};

afterEach(() => {
  capture.shutdown();
  for (const id of ['p1', 'p2', 'big', 'noise']) capture.clear(id);
});

afterAll(() => {
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('cleanOutput', () => {
  it('strips ANSI colour codes', () => {
    expect(capture.cleanOutput('\x1B[31mred\x1B[0m text')).toBe('red text');
  });

  it('strips cursor and erase sequences', () => {
    expect(capture.cleanOutput('a\x1B[2K\x1B[1Ab')).toBe('ab');
  });

  it('strips OSC window-title sequences', () => {
    expect(capture.cleanOutput('\x1B]0;my title\x07done')).toBe('done');
  });

  it('collapses a carriage-return progress bar to its final state', () => {
    expect(capture.cleanOutput('10%\r55%\r100%\n')).toBe('100%\n');
  });

  it('keeps CRLF line breaks as real lines', () => {
    expect(capture.cleanOutput('one\r\ntwo\r\n')).toBe('one\ntwo\n');
  });

  it('keeps tabs and ordinary text untouched', () => {
    expect(capture.cleanOutput('col1\tcol2\nrow')).toBe('col1\tcol2\nrow');
  });

  it('drops stray control characters', () => {
    expect(capture.cleanOutput('a\x00b\x07c')).toBe('abc');
  });
});

describe('record + flush', () => {
  it('writes captured output to the project log', () => {
    capture.record('p1', 'hello world\n');
    capture.flush();
    expect(readLog('p1')).toBe('hello world\n');
  });

  it('appends across separate chunks', () => {
    capture.record('p1', 'first\n');
    capture.flush();
    capture.record('p1', 'second\n');
    capture.flush();
    expect(readLog('p1')).toBe('first\nsecond\n');
  });

  it('keeps each project in its own file', () => {
    capture.record('p1', 'from one\n');
    capture.record('p2', 'from two\n');
    capture.flush();
    expect(readLog('p1')).toBe('from one\n');
    expect(readLog('p2')).toBe('from two\n');
  });

  it('strips escape sequences on the way in', () => {
    capture.record('noise', '\x1B[32mok\x1B[0m\n');
    capture.flush();
    expect(readLog('noise')).toBe('ok\n');
  });

  it('ignores output from a terminal with no project', () => {
    capture.record(null, 'orphan\n');
    capture.record(undefined, 'orphan\n');
    capture.flush();
    expect(readLog('null')).toBeNull();
  });

  it('ignores empty and whitespace-only escape noise', () => {
    capture.record('p1', '');
    capture.record('p1', '\x1B[0m');
    capture.flush();
    expect(readLog('p1')).toBeNull();
  });

  it('flushing with nothing buffered does not create a file', () => {
    capture.flush();
    expect(readLog('p1')).toBeNull();
  });
});

describe('size cap', () => {
  it('keeps the tail and drops the head once over the cap', () => {
    // 4000 numbered lines is comfortably past the 256 KB cap.
    for (let i = 0; i < 4000; i++) capture.record('big', `line ${i} ${'x'.repeat(80)}\n`);
    capture.flush();

    const log = readLog('big');
    expect(Buffer.byteLength(log, 'utf8')).toBeLessThanOrEqual(capture.MAX_FILE_BYTES);
    // The most recent line survives; the first does not.
    expect(log).toContain('line 3999');
    expect(log).not.toContain('line 0 ');
  });

  it('never starts the log mid-line after trimming', () => {
    for (let i = 0; i < 4000; i++) capture.record('big', `line ${i} ${'y'.repeat(80)}\n`);
    capture.flush();
    expect(readLog('big').startsWith('line ')).toBe(true);
  });
});

describe('clear', () => {
  it('removes the log and any pending buffer', () => {
    capture.record('p1', 'temporary\n');
    capture.flush();
    expect(readLog('p1')).not.toBeNull();
    capture.clear('p1');
    expect(readLog('p1')).toBeNull();
  });

  it('clearing a project that never wrote anything is a no-op', () => {
    expect(() => capture.clear('never-existed')).not.toThrow();
  });
});
