// Navigation helpers behind "jump to this thing" in the command palette.
//
// These exist because the sources used to guess: click a tab, wait 150 ms, hope
// the target is there. The dashboard finishes rendering well over a second after
// its tab is clicked, so the Kanban jump reliably landed on an empty screen.

const nav = require('../../src/renderer/services/mention-sources/_navigate');

beforeEach(() => { document.body.innerHTML = ''; });

describe('waitFor', () => {
  test('resolves as soon as the element exists', async () => {
    document.body.innerHTML = '<div id="here"></div>';
    await expect(nav.waitFor(() => document.getElementById('here'))).resolves.not.toBeNull();
  });

  test('keeps looking while the panel is still rendering', async () => {
    const found = nav.waitFor(() => document.getElementById('late'), 2000);
    setTimeout(() => { document.body.innerHTML = '<div id="late"></div>'; }, 200);
    expect(await found).not.toBeNull();
  });

  test('gives up quietly instead of hanging or throwing', async () => {
    await expect(nav.waitFor(() => null, 120)).resolves.toBeNull();
  });

  test('a finder that throws is treated as "not yet"', async () => {
    await expect(nav.waitFor(() => { throw new Error('mid-render'); }, 120)).resolves.toBeNull();
  });
});

describe('waitForByData', () => {
  test('finds an element by a data value that is not selector-safe', async () => {
    // Ids here are user-derived slugs; interpolating one into a selector would
    // be a syntax error on the first entry titled with a quote or a bracket.
    document.body.innerHTML = `
      <div class="knowledge-card" data-id="plain"></div>
      <div class="knowledge-card" data-id='we"ird ]id'></div>`;
    const el = await nav.waitForByData('.knowledge-card', 'id', 'we"ird ]id');
    expect(el).not.toBeNull();
    expect(el.dataset.id).toBe('we"ird ]id');
  });

  test('returns null when nothing carries that value', async () => {
    document.body.innerHTML = '<div class="kanban-card" data-task-id="a"></div>';
    await expect(nav.waitForByData('.kanban-card', 'taskId', 'b', 120)).resolves.toBeNull();
  });
});

describe('selectProject', () => {
  const clicks = () => [...document.querySelectorAll('[data-project-id]')]
    .filter(el => el.dataset.clicked).map(el => el.dataset.projectId);

  function build(markup) {
    document.body.innerHTML = markup;
    document.querySelectorAll('[data-project-id]').forEach(el => {
      el.addEventListener('click', () => { el.dataset.clicked = '1'; });
    });
  }

  test('clicks the project tab in tabs navigation', () => {
    build(`
      <div class="project-tab active" data-project-id="p1"></div>
      <div class="project-tab" data-project-id="p2"></div>`);
    expect(nav.selectProject('p2')).toBe(true);
    expect(clicks()).toEqual(['p2']);
  });

  test('clicks the project row in sidebar navigation', () => {
    build(`
      <div class="project-item active" data-project-id="p1"></div>
      <div class="project-item" data-project-id="p2"></div>`);
    expect(nav.selectProject('p2')).toBe(true);
    expect(clicks()).toEqual(['p2']);
  });

  test('does not re-click the project that is already active', () => {
    build('<div class="project-tab active" data-project-id="p1"></div>');
    expect(nav.selectProject('p1')).toBe(true);
    expect(clicks()).toEqual([]);
  });

  test('reports false when the project is not on screen', () => {
    build('<div class="project-tab" data-project-id="p1"></div>');
    // A collapsed folder or an active filter — the caller carries on regardless.
    expect(nav.selectProject('hidden')).toBe(false);
    expect(nav.selectProject(null)).toBe(false);
    expect(clicks()).toEqual([]);
  });
});

describe('reveal', () => {
  test('scrolls the element into view and flashes it', () => {
    document.body.innerHTML = '<div id="card"></div>';
    const el = document.getElementById('card');
    el.scrollIntoView = jest.fn();
    jest.useFakeTimers();
    try {
      nav.reveal(el, 'kanban-card-focus', 500);
      expect(el.scrollIntoView).toHaveBeenCalled();
      expect(el.classList.contains('kanban-card-focus')).toBe(true);
      jest.advanceTimersByTime(600);
      expect(el.classList.contains('kanban-card-focus')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a missing target is a no-op, not a crash', () => {
    expect(() => nav.reveal(null, 'x')).not.toThrow();
  });
});

describe('openTab', () => {
  test('clicks the sidebar tab and waits for the panel to render', async () => {
    document.body.innerHTML = '<button data-tab="dashboard"></button>';
    document.querySelector('[data-tab="dashboard"]').addEventListener('click', () => {
      // The real dashboard draws its view tabs only after its data lands.
      setTimeout(() => {
        document.body.insertAdjacentHTML('beforeend',
          '<button class="dashboard-view-tab" data-view="kanban"></button>');
      }, 150);
    });
    const el = await nav.openTab('dashboard', '.dashboard-view-tab[data-view="kanban"]', 2000);
    expect(el).not.toBeNull();
  });

  test('returns null rather than hanging when the panel never renders it', async () => {
    document.body.innerHTML = '<button data-tab="dashboard"></button>';
    await expect(nav.openTab('dashboard', '.never', 120)).resolves.toBeNull();
  });
});
