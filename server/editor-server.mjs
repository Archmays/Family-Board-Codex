import { startFamilyBoardServer } from './index.mjs';

const app = await startFamilyBoardServer();
console.log(`Family Board editor: ${app.address.url}`);

let stopping = false;
async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  await app.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
