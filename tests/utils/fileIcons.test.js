const { getFileIcon } = require('../../src/renderer/utils/fileIcons');

describe('getFileIcon', () => {
  describe('directories', () => {
    test('closed directory contains "fe-icon-folder"', () => {
      const icon = getFileIcon('src', true, false);
      expect(icon).toContain('fe-icon-folder');
      expect(icon).not.toContain('fe-icon-folder-open');
    });

    test('open directory contains "fe-icon-folder-open"', () => {
      const icon = getFileIcon('src', true, true);
      expect(icon).toContain('fe-icon-folder-open');
    });
  });

  describe('extensions', () => {
    test('app.js returns icon containing "JS"', () => {
      expect(getFileIcon('app.js')).toContain('JS');
    });

    test('style.css returns icon containing "CSS"', () => {
      expect(getFileIcon('style.css')).toContain('CSS');
    });

    test('app.ts returns icon containing "TS"', () => {
      expect(getFileIcon('app.ts')).toContain('TS');
    });

    test('script.py returns icon containing "PY"', () => {
      expect(getFileIcon('script.py')).toContain('PY');
    });
  });

  describe('special filenames', () => {
    test('package.json returns icon containing "NPM"', () => {
      expect(getFileIcon('package.json')).toContain('NPM');
    });

    test('.gitignore returns icon containing "GIT"', () => {
      expect(getFileIcon('.gitignore')).toContain('GIT');
    });

    test('Dockerfile returns icon containing "DOCK"', () => {
      expect(getFileIcon('Dockerfile')).toContain('DOCK');
    });
  });

  describe('fallback', () => {
    test('unknown.xyz returns default file icon with "fe-icon"', () => {
      const icon = getFileIcon('unknown.xyz');
      expect(icon).toContain('fe-icon');
    });

    test('file with no extension returns default file icon', () => {
      const icon = getFileIcon('Makefile');
      expect(icon).toContain('fe-icon');
    });
  });

  // ── Additional extension coverage ──

  describe('JavaScript / TypeScript extensions', () => {
    test('.mjs returns JS icon', () => {
      expect(getFileIcon('module.mjs')).toContain('JS');
    });

    test('.tsx returns TSX icon', () => {
      expect(getFileIcon('component.tsx')).toContain('TSX');
    });

    test('.jsx returns JSX icon', () => {
      expect(getFileIcon('component.jsx')).toContain('JSX');
    });
  });

  describe('Web extensions', () => {
    test('.html returns HTML icon', () => {
      expect(getFileIcon('index.html')).toContain('HTML');
    });

    test('.scss returns SCSS icon', () => {
      expect(getFileIcon('styles.scss')).toContain('SCSS');
    });

    test('.less returns LESS icon', () => {
      expect(getFileIcon('theme.less')).toContain('LESS');
    });

    test('.svg returns SVG icon', () => {
      expect(getFileIcon('logo.svg')).toContain('SVG');
    });
  });

  describe('Data / Config extensions', () => {
    test('.json returns JSON icon', () => {
      expect(getFileIcon('data.json')).toContain('JSON');
    });

    test('.yaml returns YAML icon', () => {
      expect(getFileIcon('config.yaml')).toContain('YAML');
    });

    test('.yml returns YML icon', () => {
      expect(getFileIcon('config.yml')).toContain('YML');
    });

    test('.xml returns XML icon', () => {
      expect(getFileIcon('data.xml')).toContain('XML');
    });

    test('.toml returns TOML icon', () => {
      expect(getFileIcon('Cargo.toml')).toContain('TOML');
    });

    test('.ini returns INI icon', () => {
      expect(getFileIcon('settings.ini')).toContain('INI');
    });

    test('.env (as extension) returns ENV icon', () => {
      expect(getFileIcon('app.env')).toContain('ENV');
    });
  });

  describe('Language extensions', () => {
    test('.lua returns LUA icon', () => {
      expect(getFileIcon('script.lua')).toContain('LUA');
    });

    test('.go returns GO icon', () => {
      expect(getFileIcon('main.go')).toContain('GO');
    });

    test('.rs returns RS icon', () => {
      expect(getFileIcon('lib.rs')).toContain('RS');
    });

    test('.java returns JAVA icon', () => {
      expect(getFileIcon('Main.java')).toContain('JAVA');
    });

    test('.cs returns C# icon', () => {
      expect(getFileIcon('Program.cs')).toContain('C#');
    });

    test('.cpp returns C++ icon', () => {
      expect(getFileIcon('main.cpp')).toContain('C++');
    });

    test('.c returns C icon', () => {
      const icon = getFileIcon('main.c');
      expect(icon).toContain('>C<');
    });

    test('.php returns PHP icon', () => {
      expect(getFileIcon('index.php')).toContain('PHP');
    });

    test('.rb returns RB icon', () => {
      expect(getFileIcon('app.rb')).toContain('RB');
    });

    test('.sh returns SH icon', () => {
      expect(getFileIcon('deploy.sh')).toContain('SH');
    });

    test('.bat returns BAT icon', () => {
      expect(getFileIcon('run.bat')).toContain('BAT');
    });

    test('.ps1 returns PS1 icon', () => {
      expect(getFileIcon('setup.ps1')).toContain('PS1');
    });

    test('.sql returns SQL icon', () => {
      expect(getFileIcon('schema.sql')).toContain('SQL');
    });
  });

  describe('Document extensions', () => {
    test('.md returns MD icon', () => {
      expect(getFileIcon('README.md')).toContain('MD');
    });

    test('.txt returns a text file icon', () => {
      const icon = getFileIcon('notes.txt');
      expect(icon).toContain('fe-icon');
      expect(icon).toContain('svg');
    });
  });

  describe('Image extensions', () => {
    test('.png returns image icon (green)', () => {
      expect(getFileIcon('photo.png')).toContain('#4caf50');
    });

    test('.jpg returns image icon', () => {
      expect(getFileIcon('photo.jpg')).toContain('#4caf50');
    });

    test('.jpeg returns image icon', () => {
      expect(getFileIcon('photo.jpeg')).toContain('#4caf50');
    });

    test('.gif returns image icon', () => {
      expect(getFileIcon('anim.gif')).toContain('#4caf50');
    });

    test('.webp returns image icon', () => {
      expect(getFileIcon('image.webp')).toContain('#4caf50');
    });

    test('.ico returns image icon', () => {
      expect(getFileIcon('favicon.ico')).toContain('#4caf50');
    });
  });

  // ── Special filenames (extended) ──

  describe('special filenames (extended)', () => {
    test('package-lock.json returns NPM icon', () => {
      expect(getFileIcon('package-lock.json')).toContain('NPM');
    });

    test('LICENSE returns LIC icon', () => {
      expect(getFileIcon('LICENSE')).toContain('LIC');
    });

    test('.env returns ENV icon (via FILENAME_MAP)', () => {
      expect(getFileIcon('.env')).toContain('ENV');
    });

    test('.env.local returns ENV icon', () => {
      expect(getFileIcon('.env.local')).toContain('ENV');
    });

    test('.env.development returns ENV icon', () => {
      expect(getFileIcon('.env.development')).toContain('ENV');
    });

    test('.env.production returns ENV icon', () => {
      expect(getFileIcon('.env.production')).toContain('ENV');
    });
  });

  // ── Directory icon states ──

  describe('directory icon states (extended)', () => {
    test('directory name does not affect icon (always folder)', () => {
      const icon1 = getFileIcon('src', true, false);
      const icon2 = getFileIcon('dist', true, false);
      expect(icon1).toBe(icon2);
    });

    test('directory ignores file extension in name', () => {
      const icon = getFileIcon('test.js', true, false);
      expect(icon).toContain('fe-icon-folder');
    });
  });

  // ── Fallback / edge cases ──

  describe('fallback and edge cases (extended)', () => {
    test('file with no extension and not in FILENAME_MAP returns default', () => {
      const icon = getFileIcon('CHANGELOG');
      expect(icon).toContain('fe-icon');
    });

    test('double extension uses last extension', () => {
      // .gz is not in ICON_MAP, so fallback
      const icon = getFileIcon('backup.tar.gz');
      expect(icon).toContain('fe-icon');
    });

    test('hidden file with known extension', () => {
      const icon = getFileIcon('.eslintrc.json');
      expect(icon).toContain('JSON');
    });

    test('dotfile without mapped extension returns default', () => {
      const icon = getFileIcon('.prettierrc');
      expect(icon).toContain('fe-icon');
    });
  });

  // ── Case insensitivity ──

  describe('case insensitivity', () => {
    test('.JS (uppercase) returns JS icon', () => {
      expect(getFileIcon('app.JS')).toContain('JS');
    });

    test('.Py (mixed case) returns PY icon', () => {
      expect(getFileIcon('script.Py')).toContain('PY');
    });

    test('.HTML (uppercase) returns HTML icon', () => {
      expect(getFileIcon('index.HTML')).toContain('HTML');
    });

    test('.Ts (mixed case) returns TS icon', () => {
      expect(getFileIcon('file.Ts')).toContain('TS');
    });

    test('.CSS (uppercase) returns CSS icon', () => {
      expect(getFileIcon('style.CSS')).toContain('CSS');
    });

    test('.JSON (uppercase) returns JSON icon', () => {
      expect(getFileIcon('data.JSON')).toContain('JSON');
    });

    test('.LUA (uppercase) returns LUA icon', () => {
      expect(getFileIcon('script.LUA')).toContain('LUA');
    });

    test('.Rs (mixed case) returns RS icon', () => {
      expect(getFileIcon('lib.Rs')).toContain('RS');
    });
  });

  // ── All ICON_MAP extensions produce SVG output ──

  describe('all mapped extensions produce valid SVG', () => {
    const extensions = [
      'js', 'mjs', 'ts', 'tsx', 'jsx',
      'html', 'css', 'scss', 'less', 'svg',
      'json', 'yaml', 'yml', 'xml', 'toml', 'ini', 'env',
      'py', 'lua', 'go', 'rs', 'java', 'cs', 'cpp', 'c', 'php', 'rb',
      'sh', 'bat', 'ps1', 'sql',
      'md', 'txt',
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico',
    ];

    extensions.forEach(ext => {
      test(`file.${ext} returns an SVG icon`, () => {
        const icon = getFileIcon(`file.${ext}`);
        expect(icon).toContain('<svg');
        expect(icon).toContain('</svg>');
      });
    });
  });
});
