const { isSafeImage } = require('../../src/renderer/utils/projectImage');

describe('project images', () => {
  test('accepts only the data: URLs the picker produces', () => {
    expect(isSafeImage('data:image/webp;base64,UklGRhIAAABXRUJQ')).toBe(true);
    expect(isSafeImage('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
  });

  test('refuses anything that could escape a src attribute or load elsewhere', () => {
    expect(isSafeImage('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isSafeImage('data:image/png;base64,abc" onerror="alert(1)')).toBe(false);
    expect(isSafeImage('file:///etc/passwd')).toBe(false);
    expect(isSafeImage('https://example.com/a.png')).toBe(false);
    expect(isSafeImage(null)).toBe(false);
    expect(isSafeImage(`data:image/png;base64,${'A'.repeat(300000)}`)).toBe(false);
  });
});
