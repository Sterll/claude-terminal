const {
  classifyFile,
  shouldInlineText,
  extensionOf,
  formatBytes,
  MAX_INLINE_TEXT_BYTES,
} = require('../../src/renderer/utils/attachments');

describe('classifyFile', () => {
  test('routes the four media types the API accepts to image blocks', () => {
    expect(classifyFile({ name: 'a.png', type: 'image/png' })).toBe('image');
    expect(classifyFile({ name: 'a.jpg', type: 'image/jpeg' })).toBe('image');
    expect(classifyFile({ name: 'a.gif', type: 'image/gif' })).toBe('image');
    expect(classifyFile({ name: 'a.webp', type: 'image/webp' })).toBe('image');
  });

  test('refuses image formats the API does not accept', () => {
    expect(classifyFile({ name: 'a.bmp', type: 'image/bmp' })).toBeNull();
    expect(classifyFile({ name: 'a.tiff', type: 'image/tiff' })).toBeNull();
  });

  test('recovers an image from its extension when the browser gives no type', () => {
    expect(classifyFile({ name: 'screenshot.PNG', type: '' })).toBe('image');
    expect(classifyFile({ name: 'photo.jpeg', type: '' })).toBe('image');
  });

  test('routes PDFs to document blocks, by type or by extension', () => {
    expect(classifyFile({ name: 'spec.pdf', type: 'application/pdf' })).toBe('pdf');
    expect(classifyFile({ name: 'spec.pdf', type: '' })).toBe('pdf');
  });

  // The bug this module exists to fix: these all used to be dropped in silence.
  test('accepts the text formats other Claude clients accept', () => {
    for (const name of [
      'notes.md', 'README.markdown', 'data.csv', 'rows.tsv', 'conf.yaml',
      'conf.yml', 'pkg.json', 'Cargo.toml', 'setup.ini', 'log.txt',
      'page.html', 'style.css', 'app.ts', 'main.py', 'query.sql',
      'schema.graphql', 'change.patch', 'notes.rst',
    ]) {
      expect(classifyFile({ name, type: '' })).toBe('text');
    }
  });

  test('accepts extension-less names that are still text', () => {
    expect(classifyFile({ name: 'Dockerfile', type: '' })).toBe('text');
    expect(classifyFile({ name: 'Makefile', type: '' })).toBe('text');
    expect(classifyFile({ name: 'LICENSE', type: '' })).toBe('text');
  });

  test('accepts dotfiles', () => {
    expect(classifyFile({ name: '.gitignore', type: '' })).toBe('text');
    expect(classifyFile({ name: '.env', type: '' })).toBe('text');
    expect(classifyFile({ name: '.editorconfig', type: '' })).toBe('text');
  });

  test('falls back to the media type when the extension is unknown', () => {
    expect(classifyFile({ name: 'weird.qqq', type: 'text/plain' })).toBe('text');
    expect(classifyFile({ name: 'weird.qqq', type: 'application/json' })).toBe('text');
  });

  test('refuses binary formats the API rejects in document blocks', () => {
    expect(classifyFile({ name: 'report.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBeNull();
    expect(classifyFile({ name: 'book.xlsx', type: '' })).toBeNull();
    expect(classifyFile({ name: 'archive.zip', type: 'application/zip' })).toBeNull();
    expect(classifyFile({ name: 'app.exe', type: '' })).toBeNull();
  });

  test('survives missing fields', () => {
    expect(classifyFile({})).toBeNull();
    expect(classifyFile(null)).toBeNull();
  });
});

describe('shouldInlineText', () => {
  test('inlines a small file that lives on disk', () => {
    expect(shouldInlineText({ size: 4096, path: '/tmp/a.md' })).toBe(true);
  });

  test('hands over the path once the file is large', () => {
    expect(shouldInlineText({ size: MAX_INLINE_TEXT_BYTES + 1, path: '/tmp/big.csv' })).toBe(false);
  });

  // Nothing for the Read tool to open, so size cannot be the deciding factor.
  test('inlines a file with no path however large it is', () => {
    expect(shouldInlineText({ size: MAX_INLINE_TEXT_BYTES * 10, path: '' })).toBe(true);
    expect(shouldInlineText({})).toBe(true);
  });
});

describe('extensionOf', () => {
  test('lowercases and strips the directory part', () => {
    expect(extensionOf('/a/b/Notes.MD')).toBe('md');
    expect(extensionOf('C:\\docs\\notes.TXT')).toBe('txt');
  });

  test('treats a leading dot as a dotfile, not an extension', () => {
    expect(extensionOf('.gitignore')).toBe('');
  });

  test('returns empty for a name with no extension', () => {
    expect(extensionOf('Makefile')).toBe('');
  });
});

describe('formatBytes', () => {
  test('scales the unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
