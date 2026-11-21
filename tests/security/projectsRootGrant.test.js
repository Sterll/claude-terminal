const os = require('os');
const path = require('path');
const { isGrantableProjectsRoot } = require('../../src/main/utils/rendererSecurity');

describe('projects folder granted at boot', () => {
  const home = os.homedir();

  test('a folder inside or outside home is grantable', () => {
    expect(isGrantableProjectsRoot(path.join(home, 'code'), home)).toBe(true);
    expect(isGrantableProjectsRoot(path.join(path.parse(home).root, 'work', 'projects'), home)).toBe(true);
  });

  test('never the home folder itself, a filesystem root, or a relative path', () => {
    expect(isGrantableProjectsRoot(home, home)).toBe(false);
    expect(isGrantableProjectsRoot(home + path.sep, home)).toBe(false);
    expect(isGrantableProjectsRoot(path.parse(home).root, home)).toBe(false);
    expect(isGrantableProjectsRoot('code', home)).toBe(false);
    expect(isGrantableProjectsRoot(null, home)).toBe(false);
    expect(isGrantableProjectsRoot(`${home}/x\0y`, home)).toBe(false);
  });
});
