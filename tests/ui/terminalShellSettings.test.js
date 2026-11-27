/**
 * Settings, General: the shell and external terminal card (issue #255).
 *
 * The lists come from main; the card shows them, keeps a value this machine
 * does not have visible instead of replacing it, shows the sub-fields only
 * where they apply, and saves its own fields on change.
 */

const mockUpdateSettings = jest.fn();
const mockSettings = { value: {} };
jest.mock('../../src/renderer/state/settings.state', () => ({
  getSettings: () => mockSettings.value,
  updateSettings: (...a) => mockUpdateSettings(...a),
}));

const { mountTerminalShellSettings, visibleRows } = require('../../src/renderer/ui/components/terminalShellSettings');

const OPTIONS = {
  platform: 'win32',
  shells: [{ id: 'pwsh', label: 'PowerShell 7' }, { id: 'git-bash', label: 'Git Bash' }],
  defaultShell: 'Windows PowerShell',
  externalTerminals: [{ id: 'wt', label: 'Windows Terminal', supportsProfile: true }, { id: 'cmd', label: 'Command Prompt', supportsProfile: false }],
  defaultExternalTerminal: 'wt',
  terminalProfiles: ['PowerShell', 'Git Bash'],
};

function api(options = OPTIONS) {
  return {
    terminal: { shellOptions: jest.fn(async () => options), openExternal: jest.fn(async () => ({ success: true })) },
    dialog: { selectFile: jest.fn(async () => 'C:\\msys64\\usr\\bin\\zsh.exe') },
  };
}

async function mount(settings = {}, a = api()) {
  mockSettings.value = settings;
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root');
  await mountTerminalShellSettings(root, { api: a });
  return { root, a };
}

beforeEach(() => mockUpdateSettings.mockClear());

describe('terminal shell settings card', () => {
  it('lists the default, what main found, then Custom', async () => {
    const { root } = await mount();
    const values = [...root.querySelectorAll('#terminal-shell-select option')].map((o) => o.value);
    expect(values).toEqual(['', 'pwsh', 'git-bash', 'custom']);
    expect(root.querySelector('#terminal-shell-select option').textContent).toContain('Windows PowerShell');
  });

  it('keeps a shell this machine does not have, marked as missing', async () => {
    const { root } = await mount({ terminalShell: 'zsh' });
    const select = root.querySelector('#terminal-shell-select');
    expect(select.value).toBe('zsh');
    expect(select.selectedOptions[0].textContent).toContain('zsh');
  });

  it('shows the custom fields only for Custom, and the profile only for Windows Terminal', async () => {
    const { root } = await mount({ externalTerminal: 'cmd' });
    const shown = (sel) => !root.querySelector(`[data-show-for="${sel}"]`).hidden;
    expect(shown('shell-custom')).toBe(false);
    expect(shown('external-profile')).toBe(false);
    const ext = root.querySelector('#external-terminal-select');
    ext.value = '';
    ext.dispatchEvent(new Event('change'));
    // '' is Windows Terminal on this machine.
    expect(shown('external-profile')).toBe(true);
    const shell = root.querySelector('#terminal-shell-select');
    shell.value = 'custom';
    shell.dispatchEvent(new Event('change'));
    expect(shown('shell-custom')).toBe(true);
  });

  it('saves its own fields on change', async () => {
    const { root } = await mount();
    root.querySelector('#terminal-shell-select').value = 'git-bash';
    root.querySelector('#external-terminal-profile').value = '  Git Bash ';
    root.querySelector('#external-terminal-profile').dispatchEvent(new Event('change'));
    expect(mockUpdateSettings).toHaveBeenLastCalledWith({
      terminalShell: 'git-bash',
      terminalShellCustomPath: '',
      terminalShellCustomArgs: '',
      externalTerminal: '',
      externalTerminalProfile: 'Git Bash',
      externalTerminalCustomCommand: '',
    });
  });

  it('fills the custom path from the file picker', async () => {
    const { root, a } = await mount({ terminalShell: 'custom' });
    root.querySelector('#terminal-shell-browse').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.dialog.selectFile).toHaveBeenCalled();
    expect(root.querySelector('#terminal-shell-custom-path').value).toBe('C:\\msys64\\usr\\bin\\zsh.exe');
    expect(mockUpdateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ terminalShell: 'custom', terminalShellCustomPath: 'C:\\msys64\\usr\\bin\\zsh.exe' }));
  });

  it('escapes what main sends', async () => {
    const { root } = await mount({}, api({ ...OPTIONS, shells: [{ id: 'x', label: '<img src=x onerror=alert(1)>' }] }));
    expect(root.querySelector('img')).toBeNull();
  });
});

describe('visibleRows', () => {
  it('reads the profile row off the effective terminal', () => {
    expect(visibleRows(OPTIONS, '', 'wt').externalProfile).toBe(true);
    expect(visibleRows(OPTIONS, '', 'cmd').externalProfile).toBe(false);
    expect(visibleRows({ ...OPTIONS, defaultExternalTerminal: 'cmd' }, '', '').externalProfile).toBe(false);
  });
});
