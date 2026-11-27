import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PreviewFailure } from '../errors.ts';

const exec = promisify(execFile);
const destination = '/dev/fd/1';
// AOSP's DumpCommand spells "hierarchy" as "hierchary" in its success message.
const confirmation = /UI (?:hierchary|hierarchy) dumped to: \/dev\/fd\/1\r?\n$/;
const unsupportedPath = /\/dev\/fd\/1[^\n]*(?:Permission denied|No such file|Read-only file system)/i;
const maxBuffer = 24 * 1024 * 1024;

export function startAndroidHierarchyDump(serial: string, executable = 'adb') {
  const command = exec(executable, ['-s', serial, 'exec-out', 'uiautomator', 'dump', destination],
    { encoding: 'utf8', timeout: 25_000, maxBuffer });
  const stdout = command.child.stdout!;
  // DumpCommand prints its confirmation after disconnecting from accessibility. The
  // adb pipe stays open during app_process teardown and must still drain on shutdown.
  const closed = command.then(() => {}, () => {});
  const xml = new Promise<string | null>((resolve, reject) => {
    const chunks: string[] = [];
    let tail = '';
    let bytes = 0;
    let confirmed = false;
    function receive(chunk: string) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBuffer) { stdout.off('data', receive); return; }
      chunks.push(chunk);
      tail = (tail + chunk).slice(-80);
      if (!confirmation.test(tail)) return;
      const document = chunks.join('').replace(confirmation, '').trimEnd();
      if (!document.endsWith('</hierarchy>')) return;
      confirmed = true;
      stdout.off('data', receive);
      chunks.length = 0;
      resolve(document);
    }
    stdout.on('data', receive);
    void command.then(({ stdout: output, stderr }) => {
      stdout.off('data', receive);
      if (confirmed) return;
      // Retry after exit if the stdout destination or its framing is unsupported.
      // A partial document followed by a success banner is still a failed dump.
      const banner = confirmation.exec(output.trimStart());
      if (banner?.index === 0 || (!banner && output.includes('</hierarchy>')) || unsupportedPath.test(output + stderr)) {
        resolve(null);
      } else {
        reject(new PreviewFailure('NATIVE_TREE_UNAVAILABLE', 'Android did not confirm a complete accessibility hierarchy.'));
      }
    }, error => {
      stdout.off('data', receive);
      if (error.code === 1 && unsupportedPath.test(String(error.stdout) + error.stderr)) {
        resolve(null);
      } else {
        reject(new PreviewFailure('NATIVE_TOOL_FAILED', error.message));
      }
    });
  });
  return { xml, closed };
}
