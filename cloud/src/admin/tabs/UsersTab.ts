/**
 * UsersTab — User management with interactive table.
 * Arrow keys to navigate, A/D/R for actions.
 */

import { Screen } from '../Screen';
import { c, style, padR, trunc, fmtDate } from '../ansi';
import { store, UserData } from '../../store/store';
import { generateApiKey, hashApiKey, invalidateKeyIndex } from '../../auth/auth';
import readline from 'readline';

export class UsersTab {
  private screen: Screen;
  private users: string[] = [];
  private cache: Map<string, UserData> = new Map();
  private projectCounts: Map<string, number> = new Map();
  selectedIndex: number = 0;

  // Modal state
  private modal: { type: 'confirm-delete' | 'show-key' | 'input-name'; data?: any } | null = null;
  private inputBuffer: string = '';
  private requestRender: (() => void) | null = null;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  setRenderCallback(cb: () => void): void {
    this.requestRender = cb;
  }

  async load(): Promise<void> {
    this.users = await store.listUsers();
    this.cache.clear();
    this.projectCounts.clear();

    for (const name of this.users) {
      const user = await store.getUser(name);
      if (user) {
        this.cache.set(name, user);
        const dirs = await store.listProjectDirs(name);
        this.projectCounts.set(name, dirs.length);
      }
    }

    if (this.selectedIndex >= this.users.length) {
      this.selectedIndex = Math.max(0, this.users.length - 1);
    }
  }

  render(): void {
    const s = this.screen;
    const w = s.width - 4;
    const col = 3;

    if (this.users.length === 0) {
      s.writeStyled(6, col, 'No users yet.', c.gray);
      s.writeStyled(7, col, 'Press ', c.gray);
      s.writeAt(7, col + 6, style('A', c.bold, c.amber) + style(' to create the first user.', c.gray));
      return;
    }

    // ── Table ──
    const maxRows = Math.min(this.users.length, s.height - 18);
    const tableH = maxRows + 4;
    const r = s.drawBox(5, col, w, tableH, `Users (${this.users.length})`);

    // Header
    const nameW = 18;
    const projW = 10;
    const sessW = 12;
    const keyW = 16;
    const dateW = 12;
    const header = padR('NAME', nameW) + padR('PROJECTS', projW) + padR('SESSIONS', sessW) + padR('API KEY', keyW) + 'CREATED';
    s.writeStyled(r, col + 2, header, c.bold, c.gray);
    s.writeStyled(r + 1, col + 2, '─'.repeat(w - 4), c.gray);

    // Scroll offset
    const scrollOffset = Math.max(0, this.selectedIndex - maxRows + 1);

    // Rows
    for (let i = 0; i < maxRows; i++) {
      const idx = scrollOffset + i;
      if (idx >= this.users.length) break;

      const name = this.users[idx];
      const user = this.cache.get(name);
      if (!user) continue;

      const isSelected = idx === this.selectedIndex;
      const projects = this.projectCounts.get(name) || 0;
      const activeCount = user.sessions.filter(s => s.status === 'running').length;
      const sessStr = activeCount > 0 ? `${activeCount} active` : '0';
      const keyHash = user.apiKeyHash ? user.apiKeyHash.slice(0, 12) + '...' : '(legacy)';
      const created = fmtDate(user.createdAt);

      const prefix = isSelected ? style('▸ ', c.amber) : '  ';
      const line = prefix + padR(trunc(name, nameW - 2), nameW - 2)
        + padR(String(projects), projW)
        + padR(sessStr, sessW)
        + padR(keyHash, keyW)
        + created;

      if (isSelected) {
        s.writeAt(r + 2 + i, col + 2, style(line, c.bold, c.white));
      } else {
        s.writeAt(r + 2 + i, col + 2, style(line, c.reset));
      }
    }

    // ── Details Box ──
    const detailRow = 5 + tableH + 1;
    if (this.users.length > 0 && this.selectedIndex < this.users.length) {
      const selName = this.users[this.selectedIndex];
      const user = this.cache.get(selName);
      if (user) {
        const dr = s.drawBox(detailRow, col, w, 6, selName);
        s.writeAt(dr, col + 2, `${style('ID:', c.gray)}          ${user.id}`);
        s.writeAt(dr + 1, col + 2, `${style('Created:', c.gray)}     ${new Date(user.createdAt).toLocaleString()}`);
        const projDirs = this.projectCounts.get(selName) || 0;
        s.writeAt(dr + 2, col + 2, `${style('Projects:', c.gray)}    ${projDirs}`);
        const runC = user.sessions.filter(s => s.status === 'running').length;
        const idleC = user.sessions.filter(s => s.status === 'idle').length;
        s.writeAt(dr + 3, col + 2, `${style('Sessions:', c.gray)}    ${runC} running, ${idleC} idle`);
      }
    }

    // ── Actions ──
    s.writeAt(s.height - 2, col,
      style('[A]', c.bold, c.amber) + style(' Add  ', c.gray) +
      style('[D]', c.bold, c.red) + style(' Delete  ', c.gray) +
      style('[R]', c.bold, c.yellow) + style(' Reset Key', c.gray)
    );

    // ── Modal ──
    if (this.modal) this.renderModal();
  }

  onKey(key: string): void {
    // Modal takes priority
    if (this.modal) {
      this.handleModalKey(key);
      return;
    }

    switch (key) {
      case 'up':
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        break;
      case 'down':
        this.selectedIndex = Math.min(this.users.length - 1, this.selectedIndex + 1);
        break;
      case 'a':
        this.modal = { type: 'input-name' };
        this.inputBuffer = '';
        break;
      case 'd':
        if (this.users.length > 0) {
          this.modal = { type: 'confirm-delete', data: this.users[this.selectedIndex] };
        }
        break;
      case 'r':
        if (this.users.length > 0) {
          this.resetKey(this.users[this.selectedIndex]);
        }
        break;
    }
  }

  private renderModal(): void {
    if (!this.modal) return;
    const s = this.screen;
    const mw = 50;
    const mh = this.modal.type === 'show-key' ? 8 : 6;
    const mx = Math.floor((s.width - mw) / 2);
    const my = Math.floor((s.height - mh) / 2);

    s.drawBoxFilled(my, mx, mw, mh,
      this.modal.type === 'input-name' ? 'New User' :
      this.modal.type === 'confirm-delete' ? 'Confirm Delete' : 'API Key'
    );

    if (this.modal.type === 'input-name') {
      s.writeAt(my + 2, mx + 3, style('Username:', c.gray) + ' ' + this.inputBuffer + style('_', c.amber));
      s.writeAt(my + 4, mx + 3, style('[Enter] confirm  [Esc] cancel', c.gray));
    } else if (this.modal.type === 'confirm-delete') {
      s.writeAt(my + 2, mx + 3, `Delete user ${style(this.modal.data, c.bold, c.red)}?`);
      s.writeAt(my + 4, mx + 3, style('[Y] yes  [N/Esc] cancel', c.gray));
    } else if (this.modal.type === 'show-key') {
      s.writeAt(my + 2, mx + 3, `User ${style(this.modal.data.name, c.bold)} created`);
      s.writeAt(my + 3, mx + 3, style('Key:', c.gray) + ' ' + style(this.modal.data.key, c.green));
      s.writeAt(my + 5, mx + 3, 'Save this key! ' + style('[Enter/Esc] close', c.gray));
    }
  }

  private handleModalKey(key: string): void {
    if (!this.modal) return;

    if (this.modal.type === 'input-name') {
      if (key === 'escape') {
        this.modal = null;
      } else if (key === 'enter') {
        if (this.inputBuffer.length > 0) {
          this.addUser(this.inputBuffer);
        }
        this.modal = null;
      } else if (key === 'backspace') {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
        this.requestRender?.();
      } else if (key.length === 1 && /[a-zA-Z0-9_-]/.test(key)) {
        this.inputBuffer += key;
        this.requestRender?.();
      }
    } else if (this.modal.type === 'confirm-delete') {
      if (key === 'y' || key === 'Y') {
        this.deleteUser(this.modal.data);
        this.modal = null;
      } else {
        this.modal = null;
      }
    } else if (this.modal.type === 'show-key') {
      this.modal = null;
    }
  }

  private async addUser(name: string): Promise<void> {
    try {
      if (await store.userExists(name)) return;
      await store.ensureDataDirs();
      const apiKey = generateApiKey();
      await store.createUser(name, apiKey);
      this.modal = { type: 'show-key', data: { name, key: apiKey } };
      await this.load();
      this.requestRender?.();
    } catch { /* ignore */ }
  }

  private async deleteUser(name: string): Promise<void> {
    try {
      await store.deleteUser(name);
      await this.load();
      this.requestRender?.();
    } catch { /* ignore */ }
  }

  private async resetKey(name: string): Promise<void> {
    try {
      const user = await store.getUser(name);
      if (!user) return;
      const newKey = generateApiKey();
      user.apiKeyHash = hashApiKey(newKey);
      delete (user as any).apiKey;
      await store.saveUser(name, user);
      invalidateKeyIndex();
      this.modal = { type: 'show-key', data: { name, key: newKey } };
      await this.load();
      this.requestRender?.();
    } catch { /* ignore */ }
  }
}
