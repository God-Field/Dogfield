import { resolve } from 'node:path';
import { createServer } from './http/server.ts';
import { Store } from './store.ts';
import { listenFlashTcp } from './flash/transport.ts';
const port = Number(
  process.argv.find((argument) => argument.startsWith('--port='))?.slice(7) ??
    process.env.PORT ??
    8787,
);
const host = process.env.HOST ?? '0.0.0.0';
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const { server, flash } = await createServer({
  store: new Store(
    resolve(process.env.DATA_DIR ?? '.local-server', 'state.json'),
  ),
  assets: process.env.ASSET_DIR,
  allowedOrigins,
  flashAssets: process.env.FLASH_ASSET_DIR,
  flashStartingCredits: Number(process.env.FLASH_STARTING_CREDITS ?? 1000),
  flashRuffle: process.env.FLASH_RUFFLE_DIR,
});
const flashPort = Number(process.env.FLASH_PORT ?? 58001);
const flashTcp = flashPort === 0 ? undefined : await listenFlashTcp(flash, flashPort, host);
server.addHook('onClose', async () => {
  if (flashTcp) {
    await new Promise<void>((resolve, reject) => flashTcp.close((error) => error ? reject(error) : resolve()));
  }
});
try {
await server.listen({
  port,
  host,
});
} catch (error) {
  await server.close();
  throw error;
}
const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
console.log(`God Field server listening on ${host}:${port}`);
console.log(`Open http://${displayHost}:${port}`);
console.log(`Flash client: http://${displayHost}:${port}/flash/ (TCP ${flashPort}, WebSocket /flash/socket)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
