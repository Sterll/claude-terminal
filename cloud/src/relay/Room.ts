import WebSocket from 'ws';
import { config } from '../config';

export interface RoomClient {
  ws: WebSocket;
  role: 'desktop' | 'mobile';
  connectedAt: number;
}

export class Room {
  readonly userName: string;
  private desktops: Map<WebSocket, RoomClient> = new Map();
  private mobiles: Map<WebSocket, RoomClient> = new Map();

  constructor(userName: string) {
    this.userName = userName;
  }

  get isEmpty(): boolean {
    return this.desktops.size === 0 && this.mobiles.size === 0;
  }

  get hasDesktop(): boolean {
    return this.desktops.size > 0;
  }

  get desktopCount(): number {
    return this.desktops.size;
  }

  get mobileCount(): number {
    return this.mobiles.size;
  }

  get desktopConnectedAt(): number | null {
    let min = Infinity;
    for (const [, c] of this.desktops) min = Math.min(min, c.connectedAt);
    return min === Infinity ? null : min;
  }

  addDesktop(ws: WebSocket): boolean {
    if (this.desktops.size >= config.maxDesktopsPerUser) {
      // Kick oldest desktop to make room
      const oldest = [...this.desktops.entries()].sort((a, b) => a[1].connectedAt - b[1].connectedAt)[0];
      if (oldest) {
        this.sendTo(oldest[0], { type: 'relay:kicked', reason: 'too-many-desktops' });
        oldest[0].close(4001, 'Too many desktops');
        this.desktops.delete(oldest[0]);
      }
    }
    this.desktops.set(ws, { ws, role: 'desktop', connectedAt: Date.now() });

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
    if (this.desktops.size > 0) {
      this.sendTo(ws, { type: 'relay:desktop-online' });
    } else {
      this.sendTo(ws, { type: 'relay:desktop-offline' });
    }
    return true;
  }

  removeClient(ws: WebSocket): void {
    if (this.desktops.delete(ws)) {
      if (this.desktops.size === 0) {
        this.broadcastToMobiles({ type: 'relay:desktop-offline' });
      }
      return;
    }
    this.mobiles.delete(ws);
  }

  handleMessage(senderWs: WebSocket, data: string): void {
    if (this.desktops.has(senderWs)) {
      // Desktop → all mobiles
      this.broadcastToMobiles(data);
    } else if (this.mobiles.has(senderWs)) {
      // Mobile → all desktops
      this.broadcastToDesktops(data);
    }
  }

  sendToDesktop(data: string | object): boolean {
    // Send to all desktops (backwards compat — used by webhook)
    if (this.desktops.size === 0) return false;
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    let sent = false;
    for (const [, client] of this.desktops) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
        sent = true;
      }
    }
    return sent;
  }

  broadcastToDesktops(data: string | object): void {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    for (const [, client] of this.desktops) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  broadcastToMobiles(data: string | object): void {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    for (const [, client] of this.mobiles) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  broadcastToAll(data: string | object): void {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    for (const [, client] of this.desktops) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
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
