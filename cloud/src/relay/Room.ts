import WebSocket from 'ws';
import { config } from '../config';

export interface RoomClient {
  ws: WebSocket;
  role: 'desktop' | 'mobile';
  connectedAt: number;
}

export class Room {
  readonly userName: string;
  private desktop: RoomClient | null = null;
  private mobiles: Map<WebSocket, RoomClient> = new Map();

  constructor(userName: string) {
    this.userName = userName;
  }

  get isEmpty(): boolean {
    return !this.desktop && this.mobiles.size === 0;
  }

  get hasDesktop(): boolean {
    return this.desktop !== null;
  }

  get mobileCount(): number {
    return this.mobiles.size;
  }

  get desktopConnectedAt(): number | null {
    return this.desktop?.connectedAt ?? null;
  }

  addDesktop(ws: WebSocket): boolean {
    if (this.desktop) {
      // Kick previous desktop
      this.sendTo(this.desktop.ws, { type: 'relay:kicked', reason: 'new-desktop' });
      this.desktop.ws.close(4001, 'Replaced by new desktop');
    }
    this.desktop = { ws, role: 'desktop', connectedAt: Date.now() };

    // Notify mobiles
    this.broadcastToMobiles({ type: 'relay:desktop-online' });
    return true;
  }

  addMobile(ws: WebSocket): boolean {
    if (this.mobiles.size >= config.maxMobilesPerUser) {
      return false;
    }
    this.mobiles.set(ws, { ws, role: 'mobile', connectedAt: Date.now() });

    // Tell mobile if desktop is online or not
    if (this.desktop) {
      this.sendTo(ws, { type: 'relay:desktop-online' });
    } else {
      this.sendTo(ws, { type: 'relay:desktop-offline' });
    }
    return true;
  }

  removeClient(ws: WebSocket): void {
    if (this.desktop?.ws === ws) {
      this.desktop = null;
      this.broadcastToMobiles({ type: 'relay:desktop-offline' });
      return;
    }
    this.mobiles.delete(ws);
  }

  handleMessage(senderWs: WebSocket, data: string): void {
    if (this.desktop?.ws === senderWs) {
      // Desktop → all mobiles
      this.broadcastToMobiles(data);
    } else if (this.mobiles.has(senderWs)) {
      // Mobile → desktop
      if (this.desktop && this.desktop.ws.readyState === WebSocket.OPEN) {
        this.desktop.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      }
    }
  }

  sendToDesktop(data: string | object): boolean {
    if (this.desktop && this.desktop.ws.readyState === WebSocket.OPEN) {
      const msg = typeof data === 'string' ? data : JSON.stringify(data);
      this.desktop.ws.send(msg);
      return true;
    }
    return false;
  }

  broadcastToMobiles(data: string | object): void {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    for (const [, client] of this.mobiles) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  private sendTo(ws: WebSocket, data: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
