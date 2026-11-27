import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

// File watchers can deliver several events for a single editor save. Compare the
// saved time and contents, including when a filesystem has coarse timestamps.
export class SavedFiles {
  private versions = new Map<string, string | null>();
  private pending = new Map<string, symbol>();

  async changed(file: string): Promise<boolean> {
    const read = Symbol();
    this.pending.set(file, read);
    try {
      let version: string | null = null;
      try {
        const handle = await open(file, 'r');
        try {
          const info = await handle.stat({ bigint: true });
          const hash = createHash('sha256');
          for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
          version = info.mtimeNs + '/' + hash.digest('hex');
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (this.pending.get(file) !== read || this.versions.get(file) === version) return false;
      this.versions.set(file, version);
      return true;
    } finally {
      if (this.pending.get(file) === read) this.pending.delete(file);
    }
  }
}
