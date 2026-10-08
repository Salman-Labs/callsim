import { WebSocketServer, type WebSocket } from 'ws';

export interface BotServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export function listen(port: number, onConnection: (ws: WebSocket) => void): Promise<BotServer> {
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    onConnection(ws);
  });
  return new Promise((resolve, reject) => {
    const ready = (): void => {
      const address = wss.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolve({
        url: `ws://127.0.0.1:${actual}`,
        port: actual,
        close: () =>
          new Promise<void>((done, fail) => {
            for (const socket of sockets) socket.terminate();
            wss.close((err) => (err ? fail(err) : done()));
          }),
      });
    };
    if (wss.address()) ready();
    else {
      wss.once('listening', ready);
      wss.once('error', reject);
    }
  });
}
