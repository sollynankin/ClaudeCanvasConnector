import { startHttp } from './http.js';
import { LIBRARY_DIR, PORT } from './config.js';

const server = await startHttp(PORT);
if (!server) {
  console.log(`Canvas Library server is already running on http://127.0.0.1:${PORT}`);
  process.exit(0);
}
console.log(`Canvas Library server running on http://127.0.0.1:${PORT}`);
console.log(`Library folder: ${LIBRARY_DIR}`);
console.log('Leave this window open while you add modules from Canvas.');
