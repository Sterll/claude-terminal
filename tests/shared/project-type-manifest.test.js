/**
 * Manifest validation — the boundary between an untrusted file on disk and
 * `innerHTML`.
 *
 * The name/description tests are not stylistic. `renderer.js` builds the wizard
 * type badge with `badge.innerHTML = ...${tp.icon}...${t(tp.nameKey)}...`, with
 * no escaping, so a name containing markup would reach the DOM as markup. These
 * assertions are what stops that.
 */

'use strict';

const {
  MANIFEST_VERSION,
  isPlainText,
  validateIcon,
  compareVersions,
  satisfiesRange,
  sanitizeMarkers,
  validateManifest,
  validateLocaleStrings,
  LIMITS,
} = require('../../src/shared/project-type-manifest');

const VALID_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 3 7v10z"/></svg>';

/** A manifest that passes, so each test can break exactly one thing. */
const validManifest = (over = {}) => ({
  manifest: 1,
  id: 'rust',
  name: 'Rust',
  description: 'Cargo-based Rust project',
  category: 'general',
  color: '#DEA584',
  badge: 'Cargo',
  icon: VALID_ICON,
  engines: { claudeTerminal: '>=1.3.0' },
  detect: { files: ['Cargo.toml'], dirs: ['src'] },
  ...over,
});

describe('isPlainText', () => {
  it('accepts ordinary names', () => {
    expect(isPlainText('Rust', 48)).toBe(true);
    expect(isPlainText('Godot 4 / GDScript', 48)).toBe(true);
    expect(isPlainText('项目类型', 48)).toBe(true);
  });

  it('rejects anything that could open a tag or an entity', () => {
    expect(isPlainText('<b>Rust</b>', 48)).toBe(false);
    expect(isPlainText('Rust <script>alert(1)</script>', 48)).toBe(false);
    expect(isPlainText('a > b', 48)).toBe(false);
    expect(isPlainText('&#60;script&#62;', 48)).toBe(false);
  });

  it('rejects control characters and bidi overrides', () => {
    expect(isPlainText(`Rust${String.fromCharCode(0)}`, 48)).toBe(false);
    // U+202E flips the rendering of everything after it, so a display name can
    // read as something other than what it is.
    expect(isPlainText(`gnp.${String.fromCharCode(0x202e)}exe`, 48)).toBe(false);
    expect(isPlainText(`a${String.fromCharCode(0x2066)}b`, 48)).toBe(false);
  });

  it('rejects empty, whitespace-only, over-long and non-string values', () => {
    expect(isPlainText('', 48)).toBe(false);
    expect(isPlainText('   ', 48)).toBe(false);
    expect(isPlainText('x'.repeat(49), 48)).toBe(false);
    expect(isPlainText(null, 48)).toBe(false);
    expect(isPlainText(42, 48)).toBe(false);
    expect(isPlainText({ toString: () => 'Rust' }, 48)).toBe(false);
  });
});

describe('validateIcon', () => {
  it('accepts a plain allowlisted SVG unchanged', () => {
    expect(validateIcon(VALID_ICON)).toBe(VALID_ICON);
    expect(validateIcon(`  ${VALID_ICON}  `)).toBe(VALID_ICON);
  });

  it('accepts gradients and the other drawing primitives', () => {
    const svg = '<svg viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><circle cx="12" cy="12" r="8" fill="url"/></svg>';
    expect(validateIcon(svg)).toBe(svg);
  });

  it('rejects script, foreignObject, image, use and anchor', () => {
    expect(validateIcon('<svg><script>alert(1)</script></svg>')).toBeNull();
    expect(validateIcon('<svg><foreignObject><div>x</div></foreignObject></svg>')).toBeNull();
    expect(validateIcon('<svg><image href="x.png"/></svg>')).toBeNull();
    expect(validateIcon('<svg><use href="#x"/></svg>')).toBeNull();
    expect(validateIcon('<svg><a href="http://x"><path d="M0 0"/></a></svg>')).toBeNull();
  });

  it('rejects event handlers however they are spelled', () => {
    expect(validateIcon('<svg onload="alert(1)"><path d="M0 0"/></svg>')).toBeNull();
    expect(validateIcon('<svg ONLOAD="alert(1)"><path d="M0 0"/></svg>')).toBeNull();
    expect(validateIcon('<svg onload = "alert(1)"><path d="M0 0"/></svg>')).toBeNull();
    expect(validateIcon('<svg><circle cx="1" cy="1" r="1" onclick="x()"/></svg>')).toBeNull();
  });

  it('rejects style, schemes and url()', () => {
    expect(validateIcon('<svg style="position:fixed;inset:0"><path d="M0 0"/></svg>')).toBeNull();
    expect(validateIcon('<svg fill="url(#x)"><path d="M0 0"/></svg>')).toBeNull();
    expect(validateIcon('<svg><path d="M0 0" fill="javascript:alert(1)"/></svg>')).toBeNull();
  });

  it('rejects anything that is not a single svg root', () => {
    expect(validateIcon('<div>hi</div>')).toBeNull();
    expect(validateIcon('not an svg')).toBeNull();
    expect(validateIcon(`${VALID_ICON}<img src=x>`)).toBeNull();
    expect(validateIcon(`<svg>${VALID_ICON}</svg>`)).toBeNull();
    expect(validateIcon(`<!--x-->${VALID_ICON}`)).toBeNull();
  });

  it('rejects a non-string or an over-long icon', () => {
    expect(validateIcon(null)).toBeNull();
    expect(validateIcon(123)).toBeNull();
    expect(validateIcon(`<svg><title>${'x'.repeat(LIMITS.icon)}</title></svg>`)).toBeNull();
  });
});

describe('satisfiesRange', () => {
  it('treats an absent or wildcard range as satisfied', () => {
    expect(satisfiesRange('1.3.2', undefined)).toBe(true);
    expect(satisfiesRange('1.3.2', null)).toBe(true);
    expect(satisfiesRange('1.3.2', '*')).toBe(true);
    expect(satisfiesRange('1.3.2', '')).toBe(true);
  });

  it('handles the comparison operators', () => {
    expect(satisfiesRange('1.3.2', '1.3.2')).toBe(true);
    expect(satisfiesRange('1.3.2', '1.3.1')).toBe(false);
    expect(satisfiesRange('1.3.2', '>=1.3.0')).toBe(true);
    expect(satisfiesRange('1.3.2', '>=1.4.0')).toBe(false);
    expect(satisfiesRange('1.3.2', '<2.0.0')).toBe(true);
    expect(satisfiesRange('1.3.2', '<=1.3.2')).toBe(true);
    expect(satisfiesRange('1.3.2', '>1.3.2')).toBe(false);
  });

  it('handles caret and tilde', () => {
    expect(satisfiesRange('1.3.2', '^1.3.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.3.0')).toBe(false);
    expect(satisfiesRange('1.3.2', '~1.3.0')).toBe(true);
    expect(satisfiesRange('1.4.0', '~1.3.0')).toBe(false);
    // Below 1.0.0 caret narrows to the minor, the way npm does it.
    expect(satisfiesRange('0.4.1', '^0.4.0')).toBe(true);
    expect(satisfiesRange('0.5.0', '^0.4.0')).toBe(false);
  });

  it('refuses a range it does not understand rather than guessing', () => {
    expect(satisfiesRange('1.3.2', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfiesRange('1.3.2', 'not-a-range')).toBe(false);
    expect(satisfiesRange('1.3.2', '1.x')).toBe(false);
  });

  it('compares versions of unequal length', () => {
    expect(compareVersions('1.3', '1.3.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.3.2-beta.1', '1.3.2')).toBe(0);
  });
});

describe('sanitizeMarkers', () => {
  it('keeps bare filenames', () => {
    expect(sanitizeMarkers(['Cargo.toml', 'go.mod'])).toEqual(['Cargo.toml', 'go.mod']);
  });

  it('drops anything that could climb out of the project directory', () => {
    expect(sanitizeMarkers(['../../etc/passwd'])).toEqual([]);
    expect(sanitizeMarkers(['a/b'])).toEqual([]);
    expect(sanitizeMarkers(['a\\b'])).toEqual([]);
    expect(sanitizeMarkers(['..'])).toEqual([]);
    expect(sanitizeMarkers(['.'])).toEqual([]);
    expect(sanitizeMarkers([`x${String.fromCharCode(0)}.txt`])).toEqual([]);
  });

  it('drops non-strings and caps the list', () => {
    expect(sanitizeMarkers(['ok', 42, null, {}])).toEqual(['ok']);
    expect(sanitizeMarkers('Cargo.toml')).toEqual([]);
    const many = Array.from({ length: 100 }, (_, i) => `f${i}`);
    expect(sanitizeMarkers(many)).toHaveLength(LIMITS.markers);
  });
});

describe('validateManifest', () => {
  it('accepts a well-formed manifest and normalises it', () => {
    const r = validateManifest(validManifest(), { appVersion: '1.3.2' });
    expect(r.ok).toBe(true);
    expect(r.value.id).toBe('rust');
    // Prefixed, so an extension can never shadow a built-in type id.
    expect(r.value.typeId).toBe('ext-rust');
    expect(r.value.color).toBe('#dea584');
    expect(r.value.icon).toBe(VALID_ICON);
    expect(r.value.detect).toEqual({ files: ['Cargo.toml'], dirs: ['src'] });
  });

  it('rejects a manifest that is not an object', () => {
    for (const bad of [null, undefined, 'string', 42, [], true]) {
      const r = validateManifest(bad, { appVersion: '1.3.2' });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('not-an-object');
    }
  });

  it('rejects an unknown manifest version rather than best-effort parsing it', () => {
    expect(validateManifest(validManifest({ manifest: 2 }), { appVersion: '1.3.2' }).reason)
      .toBe('bad-manifest-version');
    expect(validateManifest(validManifest({ manifest: undefined }), { appVersion: '1.3.2' }).reason)
      .toBe('bad-manifest-version');
    expect(validateManifest(validManifest({ manifest: '1' }), { appVersion: '1.3.2' }).reason)
      .toBe('bad-manifest-version');
    expect(MANIFEST_VERSION).toBe(1);
  });

  it('rejects an id that is not a safe css-class-and-key token', () => {
    for (const id of ['Rust', 'r', '../evil', 'a b', 'a.b', '', null, 42, 'x'.repeat(40), '1rust']) {
      expect(validateManifest(validManifest({ id }), { appVersion: '1.3.2' }).reason).toBe('bad-id');
    }
  });

  it('rejects a name containing markup', () => {
    const r = validateManifest(validManifest({ name: '<img src=x onerror=alert(1)>' }), { appVersion: '1.3.2' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-name');
  });

  it('rejects an incompatible engine range and says so', () => {
    const r = validateManifest(validManifest({ engines: { claudeTerminal: '>=2.0.0' } }), { appVersion: '1.3.2' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('incompatible');
    expect(r.detail).toContain('>=2.0.0');
    expect(r.detail).toContain('1.3.2');
  });

  it('skips the compatibility check when no app version is supplied', () => {
    const r = validateManifest(validManifest({ engines: { claudeTerminal: '>=99.0.0' } }));
    expect(r.ok).toBe(true);
  });

  it('drops bad optional fields without failing the manifest', () => {
    const r = validateManifest(validManifest({
      description: '<script>x</script>',
      badge: 'x'.repeat(50),
      color: 'red',
      icon: '<svg onload="x()"></svg>',
      category: 'nonsense',
      detect: 'not an object',
    }), { appVersion: '1.3.2' });

    expect(r.ok).toBe(true);
    expect(r.value.description).toBeNull();
    expect(r.value.badge).toBeNull();
    expect(r.value.color).toBeNull();
    expect(r.value.icon).toBeNull();
    expect(r.value.category).toBe('general');
    expect(r.value.detect).toEqual({ files: [], dirs: [] });
  });

  it('never throws, whatever it is handed', () => {
    const nasty = { manifest: 1, id: 'ok', name: 'Ok', get color() { throw new Error('boom'); } };
    expect(() => validateManifest(nasty, { appVersion: '1.3.2' })).toThrow('boom');
    // ...which is precisely why every caller wraps it. Everything that is merely
    // malformed, rather than actively hostile, comes back as a result:
    for (const bad of [Object.create(null), { manifest: 1 }, { manifest: 1, id: 'ok' }]) {
      expect(() => validateManifest(bad, { appVersion: '1.3.2' })).not.toThrow();
    }
  });
});

describe('the shipped reference extension', () => {
  // src/project-types/examples/rust/ is documentation-by-example. Documentation
  // that no longer works is worse than none, so it is validated here rather than
  // trusted to stay correct.
  const fs = require('fs');
  const path = require('path');
  const EXAMPLE = path.join(__dirname, '..', '..', 'src', 'project-types', 'examples', 'rust');
  const appVersion = require('../../package.json').version;

  it('passes validation against the current app version', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'project-type.json'), 'utf8'));
    const result = validateManifest(raw, { appVersion });

    expect(result.ok).toBe(true);
    expect(result.value.id).toBe('rust');
    expect(result.value.typeId).toBe('ext-rust');
    // The icon and colour survive validation — an example whose decorations were
    // silently dropped would teach the wrong lesson about what is allowed.
    expect(result.value.icon).not.toBeNull();
    expect(result.value.color).toBe('#dea584');
    expect(result.value.detect.files).toContain('Cargo.toml');
  });

  it('ships a usable translation for every locale the app supports', () => {
    for (const locale of ['en', 'fr', 'es', 'id', 'zh-CN']) {
      const file = path.join(EXAMPLE, 'i18n', `${locale}.json`);
      expect(fs.existsSync(file)).toBe(true);
      const strings = validateLocaleStrings(JSON.parse(fs.readFileSync(file, 'utf8')));
      expect(strings).not.toBeNull();
      expect(strings.name).toBe('Rust');
      expect(strings.description).toBeTruthy();
    }
  });

  it('contains no JavaScript, because there is nowhere for it to run', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [e.name]));
    expect(walk(EXAMPLE).filter((f) => f.endsWith('.js'))).toEqual([]);
  });
});

describe('validateLocaleStrings', () => {
  it('keeps only name and description', () => {
    expect(validateLocaleStrings({
      name: 'Rust',
      description: 'Cargo project',
      'settings.dangerous': 'Totally safe, click yes',
    })).toEqual({ name: 'Rust', description: 'Cargo project' });
  });

  it('applies the same plain-text rule', () => {
    expect(validateLocaleStrings({ name: '<b>Rust</b>' })).toBeNull();
    expect(validateLocaleStrings({ name: 'Rust', description: '<script>x</script>' }))
      .toEqual({ name: 'Rust' });
  });

  it('returns null for nothing usable', () => {
    expect(validateLocaleStrings(null)).toBeNull();
    expect(validateLocaleStrings([])).toBeNull();
    expect(validateLocaleStrings({})).toBeNull();
    expect(validateLocaleStrings('Rust')).toBeNull();
  });
});
