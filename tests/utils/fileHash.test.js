const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { hashFile, hashFiles } = require('../../src/main/utils/fileHash');

describe('hashFile', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileHash-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  test('returns deterministic SHA256 hex hash for known content', () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    fs.writeFileSync(filePath, 'hello world');
    const expectedHash = crypto.createHash('sha256').update('hello world').digest('hex');
    return hashFile(filePath).then(hash => {
      expect(hash).toBe(expectedHash);
    });
  });

  test('returns same hash for identical content', async () => {
    const file1 = path.join(tmpDir, 'a.txt');
    const file2 = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(file1, 'same content');
    fs.writeFileSync(file2, 'same content');
    const hash1 = await hashFile(file1);
    const hash2 = await hashFile(file2);
    expect(hash1).toBe(hash2);
  });

  test('returns different hash for different content', async () => {
    const file1 = path.join(tmpDir, 'a.txt');
    const file2 = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(file1, 'content A');
    fs.writeFileSync(file2, 'content B');
    const hash1 = await hashFile(file1);
    const hash2 = await hashFile(file2);
    expect(hash1).not.toBe(hash2);
  });

  test('returns valid hex hash for empty file', async () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(filePath, '');
    const expectedHash = crypto.createHash('sha256').update('').digest('hex');
    const hash = await hashFile(filePath);
    expect(hash).toBe(expectedHash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('hash is always 64 hex characters', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'test data');
    const hash = await hashFile(filePath);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  test('rejects for non-existent file', () => {
    const fakePath = path.join(tmpDir, 'nonexistent.txt');
    return expect(hashFile(fakePath)).rejects.toThrow();
  });

  test('handles binary content', async () => {
    const filePath = path.join(tmpDir, 'binary.bin');
    const buf = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80]);
    fs.writeFileSync(filePath, buf);
    const expectedHash = crypto.createHash('sha256').update(buf).digest('hex');
    const hash = await hashFile(filePath);
    expect(hash).toBe(expectedHash);
  });
});

describe('hashFiles', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hashFiles-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  test('returns a Map with hashes for all existing files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'aaa');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'bbb');
    const result = await hashFiles(tmpDir, ['a.txt', 'b.txt']);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.has('a.txt')).toBe(true);
    expect(result.has('b.txt')).toBe(true);
    expect(result.get('a.txt')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('skips non-existent files (no entry in map)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'exists.txt'), 'data');
    const result = await hashFiles(tmpDir, ['exists.txt', 'missing.txt']);
    expect(result.size).toBe(1);
    expect(result.has('exists.txt')).toBe(true);
    expect(result.has('missing.txt')).toBe(false);
  });

  test('returns empty Map for empty paths array', async () => {
    const result = await hashFiles(tmpDir, []);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('handles more than BATCH_SIZE (20) files', async () => {
    const paths = [];
    for (let i = 0; i < 25; i++) {
      const name = `file-${i}.txt`;
      fs.writeFileSync(path.join(tmpDir, name), `content-${i}`);
      paths.push(name);
    }
    const result = await hashFiles(tmpDir, paths);
    expect(result.size).toBe(25);
  });

  test('handles files in subdirectories', async () => {
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'nested.txt'), 'nested content');
    const result = await hashFiles(tmpDir, ['sub/nested.txt']);
    expect(result.size).toBe(1);
    expect(result.has('sub/nested.txt')).toBe(true);
  });
});
