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
    <div class="main-container">
      <div class="sidebar"></div>
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
            <div class="terminals-panel">
              <div class="terminals-header" id="terminals-header"></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

const parentIdOf = (id) => document.getElementById(id)?.parentElement?.id || null;
const parentClassOf = (id) => document.getElementById(id)?.parentElement?.className || '';

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
    expect(parentClassOf('projects-popover')).toContain('main-container');
    expect(parentIdOf('project-bar-tools')).toBe('terminals-header');
    // Which screens it stands on is CSS's business, so no inline display is
    // left behind to fight the stylesheet.
    expect(document.getElementById('projects-popover').classList.contains('docked')).toBe(true);
    expect(document.getElementById('projects-popover').style.display).toBe('');
  });

  test('the docked column stands beside every screen, not inside one', () => {
    // It used to be docked into .claude-layout, so it vanished with the Claude
    // tab and left the other project screens with no project switcher.
    applyNavigationMode('sidebar');

    const children = [...document.querySelector('.main-container').children];
    const popoverAt = children.findIndex(c => c.id === 'projects-popover');
    const contentAt = children.findIndex(c => c.classList.contains('content'));
    expect(popoverAt).toBeGreaterThanOrEqual(0);
    expect(popoverAt).toBeLessThan(contentAt);
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

  test('the height the popover measured for itself does not follow it into the column', () => {
    // openProjectsPopover() sizes the popover against the + it hangs from, as
    // an inline style — which would otherwise beat the column's max-height:none
    // and cap a full-height column at a popover's worth of rows.
    applyNavigationMode('tabs');
    document.getElementById('projects-popover').style.maxHeight = '420px';

    applyNavigationMode('sidebar');

    expect(document.getElementById('projects-popover').style.maxHeight).toBe('');
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

    expect(parentClassOf('projects-popover')).toContain('main-container');
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
