import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIBRARY_DIR = path.resolve(process.env.CANVAS_LIBRARY_DIR || path.join(ROOT, 'library'));
export const PORT = Number(process.env.CANVAS_LIBRARY_PORT || 47821);
export const MAX_BODY_BYTES = 200 * 1024 * 1024;
