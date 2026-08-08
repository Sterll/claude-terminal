'use strict';

const { assert } = require('../sandbox');

module.exports = {
  type: 'shell',
  scenarios: [
    {
      name: 'captures stdout and a zero exit code',
      config: (sb) => ({ command: 'node -e "console.log(\'hello lab\')"', cwd: sb.dir }),
      assert(out) {
        assert.strictEqual(out.exitCode, 0, 'exit code should be 0');
        assert.match(out.stdout, /hello lab/);
        assert.strictEqual(out.timedOut, false);
      },
    },
    {
      name: 'reports a non-zero exit code and stderr',
      config: (sb) => ({ command: 'node -e "console.error(\'boom\'); process.exit(3)"', cwd: sb.dir }),
      assert(out) {
        assert.strictEqual(out.exitCode, 3);
        assert.match(out.stderr, /boom/);
      },
    },
    {
      name: 'runs in the configured working directory',
      async setup(sb) { sb.file('marker.txt', 'here'); },
      config: (sb) => ({ command: 'node -e "console.log(require(\'fs\').existsSync(\'marker.txt\'))"', cwd: sb.dir }),
      assert(out) {
        assert.match(out.stdout.trim(), /true/, 'command did not run in the sandbox dir');
      },
    },
    {
      name: 'interpolates $variables into the command',
      async setup(sb) { sb.vars.set('greeting', 'interpolated'); },
      config: (sb) => ({ command: 'node -e "console.log(\'$greeting\')"', cwd: sb.dir }),
      assert(out) {
        assert.match(out.stdout, /interpolated/);
      },
    },
  ],
};
