import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { FlashService } from './service.ts';
import { element, tag } from './xml.ts';

const maximumFlashFrameBytes = 65536;
const maximumBufferedTransportBytes = 1024 * 1024;
const webSocketMessageTooBigCloseCode = 1009;
const webSocketUnsupportedDataCloseCode = 1003;
const defaultFlashTcpPort = 58001;
const flashTcpIdleTimeoutMilliseconds = 120000;

export const flashPolicy = '<cross-domain-policy><allow-access-from domain="*" to-ports="*" /></cross-domain-policy>\0';

/** Keeps partial UTF-8 codepoints and partial/null-separated XML frames intact. */
export class FlashConnection {
  private readonly decoder = new StringDecoder('utf8');
  private buffered = '';
  private readonly session;
  private closed = false;

  constructor(readonly service: FlashService, readonly send: (data: string) => void, readonly close: () => void) {
    this.session = service.connect((xml) => send(`${xml}\0`));
  }

  receive(data: Buffer): void {
    if (this.closed) {
      return;
    }
    this.buffered += this.decoder.write(data);
    let separator = this.buffered.indexOf('\0');
    while (separator >= 0) {
      const frame = this.buffered.slice(0, separator);
      this.buffered = this.buffered.slice(separator + 1);
      if (Buffer.byteLength(frame) > maximumFlashFrameBytes) {
        this.close();
        return;
      }
      if (frame.trim() === '<policy-file-request/>') {
        this.send(flashPolicy);
      } else if (frame.trim()) {
        try {
          this.service.receive(this.session, frame);
        } catch {
          this.send(`${element('ERROR', tag('message', 'invalidRequest'))}\0`);
          if (/^\s*<(COMMAND|BUY)\b/.test(frame)) {
            this.service.resync(this.session);
          }
        }
      }
      separator = this.buffered.indexOf('\0');
    }
    if (Buffer.byteLength(this.buffered) > maximumFlashFrameBytes) {
      this.close();
    }
  }

  disconnect(): void {
    if (!this.closed) {
      this.closed = true;
      this.service.disconnect(this.session);
    }
  }
}

export function attachFlashWebSocket(server: HttpServer, service: FlashService): () => void {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: maximumFlashFrameBytes });
  const active = new Set<WebSocket>();
  const upgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {

    if (request.url?.split('?')[0] !== '/flash/socket') {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      active.add(websocket);
      const connection = new FlashConnection(service,
        (data) => {
          if (websocket.readyState === WebSocket.OPEN) {
            if (websocket.bufferedAmount > maximumBufferedTransportBytes) {
              websocket.close(webSocketMessageTooBigCloseCode);
              return;
            }
            websocket.send(Buffer.from(data));
          }
        }, () => websocket.close(webSocketMessageTooBigCloseCode));
      websocket.on('message', (data, binary) => {
        if (!binary) {
          websocket.close(webSocketUnsupportedDataCloseCode);
          return;
        }
        connection.receive(Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]));
      });
      websocket.on('error', () => websocket.close());
      websocket.on('close', () => {
        active.delete(websocket);
        connection.disconnect();
      });
    });
  };
  server.on('upgrade', upgrade);
  return () => {
    server.off('upgrade', upgrade);
    for (const socket of active) {
      socket.terminate();
    }
    sockets.close();
  };
}

export async function listenFlashTcp(service: FlashService, port = defaultFlashTcpPort, host = '0.0.0.0'): Promise<TcpServer> {
  const active = new Set<Socket>();
  const server = createTcpServer((socket) => {
    active.add(socket);
    socket.setTimeout(flashTcpIdleTimeoutMilliseconds);
    const connection = new FlashConnection(service, (data) => {
      if (socket.writableLength > maximumBufferedTransportBytes) {
        socket.destroy();
        return;
      }
      socket.write(data);
    }, () => socket.destroy());
    socket.on('data', (data) => connection.receive(data));
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      active.delete(socket);
      connection.disconnect();
    });
  });
  const originalClose = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    for (const socket of active) {
      socket.destroy();
    }
    return originalClose(callback);
  }) as typeof server.close;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
