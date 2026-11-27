import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { PreviewFailure } from '../errors.ts';

/** A kernel-owned loopback socket is exclusive across processes and released even on SIGKILL. */
export async function acquireDevice(platform: 'ios' | 'android', device: string) {
  const key = platform + '/' + (platform === 'ios' ? device.toLowerCase() : device);
  const port = 19000 + createHash('sha256').update(key).digest().readUInt32BE() % 10000;
  const server = createServer(socket => socket.end());
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    throw new PreviewFailure('NATIVE_DEVICE_BUSY', `Device ${device} is leased or local lease port ${port} is occupied.`);
  }
  return () => new Promise<void>(resolve => server.close(() => resolve()));
}
