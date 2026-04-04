import { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { URL } from 'url';
import { authenticateApiKey } from '../auth/auth';
import { Room } from './Room';

export class RelayServer {
  private wss: WebSocketServer;
  private rooms: Map<string, Room> = new Map();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (url.pathname !== '/relay') return;

      this.wss.handleUpgrade(req, socket, head, ws => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
  }

  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const role = url.searchParams.get('role') as 'desktop' | 'mobile';

    if (!token || !role || !['desktop', 'mobile'].includes(role)) {
      ws.close(4000, 'Missing token or role');
      return;
    }

    const userName = await authenticateApiKey(token);
    if (!userName) {
      ws.close(4003, 'Invalid API key');
      return;
    }

    // Get or create room for this user
    let room = this.rooms.get(userName);
    if (!room) {
      room = new Room(userName);
      this.rooms.set(userName, room);
    }

    if (role === 'desktop') {
      room.addDesktop(ws);
    } else {
      const ok = room.addMobile(ws);
      if (!ok) {
        ws.close(4002, 'Too many mobile connections');
        return;
      }
    }

    ws.on('message', (data) => {
      room!.handleMessage(ws, data.toString());
    });

    ws.on('close', () => {
      room!.removeClient(ws);
      if (room!.isEmpty) {
        this.rooms.delete(userName);
      }
    });

    ws.on('error', () => {
      room!.removeClient(ws);
      if (room!.isEmpty) this.rooms.delete(userName);
      ws.close();
    });
  }

  getStats(): { rooms: number; desktops: number; mobiles: number } {
    let desktops = 0;
    let mobiles = 0;
    for (const [, room] of this.rooms) {
      desktops += room.desktopCount;
      mobiles += room.mobileCount;
    }
    return { rooms: this.rooms.size, desktops, mobiles };
  }

  getRoomForUser(userName: string): Room | undefined {
    return this.rooms.get(userName);
  }

  notifyRoom(userName: string, data: object): boolean {
    const room = this.rooms.get(userName);
    if (!room) return false;
    room.broadcastToAll(data);
    return true;
  }

  listRooms(): Array<{ userName: string; hasDesktop: boolean; mobileCount: number; desktopConnectedAt: number | null }> {
    const result: Array<{ userName: string; hasDesktop: boolean; mobileCount: number; desktopConnectedAt: number | null }> = [];
    for (const [userName, room] of this.rooms) {
      result.push({
        userName,
        hasDesktop: room.hasDesktop,
        mobileCount: room.mobileCount,
        desktopConnectedAt: room.desktopConnectedAt,
      });
    }
    return result;
  }
}
