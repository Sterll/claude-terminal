// Navigation mode: two navigations ship together and only one is mounted.
//
// The two shared nodes are moved rather than duplicated, so what this really
// guards is that each mode leaves them where its layout expects them, and that
// switching back and forth is reversible.

const {
  MODES,
  isNavigationMode,
  resolveNavigationMode,
  applyNavigationMode,
  isSidebarNavigation,
} = require('../../src/renderer/ui/navigationMode');

/** The parts of index.html the mode actually moves things between. */
function buildDom() {
  document.body.className = '';
  document.body.innerHTML = `
    <div class="content">
      <div class="project-bar" id="project-bar">
        <div class="project-tabs" id="project-tabs"></div>
        <div class="project-bar-tools" id="project-bar-tools"></div>
      </div>
      <div class="projects-popover" id="projects-popover" style="display:none">
        <div class="projects-panel"><div id="projects-list"></div></div>
      </div>
      <div class="tab-content" id="tab-claude">
        <div class="claude-layout" id="claude-layout">
          <div class="file-explorer-panel" id="file-explorer-panel"></div>
          <div class="terminals-panel">
            <div class="terminals-header" id="terminals-header"></div>
          </div>
        </div>
      </div>
    </div>`;
}

const parentIdOf = (id) => document.getElementById(id)?.parentElement?.id || null;

beforeEach(buildDom);

describe('resolveNavigationMode', () => {
  test('only the two shipped navigations are modes', () => {
    expect(MODES).toEqual(['tabs', 'sidebar']);
    expect(isNavigationMode('tabs')).toBe(true);
    expect(isNavigationMode('sidebar')).toBe(true);
    expect(isNavigationMode('drawer')).toBe(false);
  });

  test('an unset or unknown setting falls back to the tab bar', () => {
    // null is what a install that has never been asked carries
    expect(resolveNavigationMode(null)).toBe('tabs');
    expect(resolveNavigationMode(undefined)).toBe('tabs');
    expect(resolveNavigationMode('drawer')).toBe('tabs');
    expect(resolveNavigationMode('sidebar')).toBe('sidebar');
  });
});

describe('applyNavigationMode', () => {
  test('sidebar docks the projects host and moves the tools into the header', () => {
    applyNavigationMode('sidebar');

    expect(isSidebarNavigation()).toBe(true);
    expect(document.body.classList.contains('nav-sidebar')).toBe(true);
    expect(document.body.classList.contains('nav-tabs')).toBe(false);
    expect(parentIdOf('projects-popover')).toBe('claude-layout');
    expect(parentIdOf('project-bar-tools')).toBe('terminals-header');
    // Permanent column, so it must not stay hidden by the popover's display
    expect(document.getElementById('projects-popover').style.display).toBe('flex');
  });

  test('the docked column sits before the file explorer, as it did', () => {
    applyNavigationMode('sidebar');

    const children = [...document.getElementById('claude-layout').children].map(c => c.id);
    expect(children.indexOf('projects-popover')).toBeLessThan(children.indexOf('file-explorer-panel'));
  });

  test('tabs puts both nodes back and closes the popover', () => {
    applyNavigationMode('sidebar');
    applyNavigationMode('tabs');

    expect(isSidebarNavigation()).toBe(false);
    expect(document.body.classList.contains('nav-tabs')).toBe(true);
    expect(parentIdOf('projects-popover')).toBe(null); // back to .content, which has no id
    expect(document.getElementById('projects-popover').parentElement.className).toBe('content');
    expect(parentIdOf('project-bar-tools')).toBe('project-bar');
    expect(document.getElementById('projects-popover').style.display).toBe('none');
  });

  test('a collapsed column does not come back collapsed as a popover', () => {
    applyNavigationMode('sidebar');
    document.getElementById('projects-popover').classList.add('collapsed');

    applyNavigationMode('tabs');

    expect(document.getElementById('projects-popover').classList.contains('collapsed')).toBe(false);
  });

  test('switching back and forth is stable', () => {
    for (let i = 0; i < 3; i++) {
      applyNavigationMode('sidebar');
      applyNavigationMode('tabs');
    }
    applyNavigationMode('sidebar');

    expect(parentIdOf('projects-popover')).toBe('claude-layout');
    expect(parentIdOf('project-bar-tools')).toBe('terminals-header');
    expect(document.querySelectorAll('#projects-popover').length).toBe(1);
    expect(document.querySelectorAll('#project-bar-tools').length).toBe(1);
  });

  test('applying the same mode twice changes nothing', () => {
    applyNavigationMode('sidebar');
    const before = document.body.innerHTML;
    applyNavigationMode('sidebar');

    expect(document.body.innerHTML).toBe(before);
  });

  test('survives a DOM that has none of those nodes yet', () => {
    document.body.innerHTML = '';
    expect(() => applyNavigationMode('sidebar')).not.toThrow();
    expect(document.body.classList.contains('nav-sidebar')).toBe(true);
  });
});
