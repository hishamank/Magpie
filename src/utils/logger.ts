import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.log.level,
  transport: {
    target: 'pino/file',
    options: { destination: 2 }, // stderr, so it doesn't mix with CLI output
  },
});

export function getLogger(name: string) {
  return logger.child({ module: name });
}
