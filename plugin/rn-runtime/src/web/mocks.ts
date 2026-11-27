import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { WebError } from './bridge.ts';

export async function projectMocks(root: string) {
  const text = await readFile(path.join(root, 'prevue.web.json'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  );
  if (text === null) return [];
  const config: unknown = JSON.parse(text);
  if (
    !config ||
    typeof config !== 'object' ||
    !('mocks' in config) ||
    !config.mocks ||
    typeof config.mocks !== 'object' ||
    Array.isArray(config.mocks)
  ) {
    throw new WebError('INVALID_WEB_CONFIG', 'prevue.web.json must declare a mocks object');
  }
  return Promise.all(
    Object.entries(config.mocks).map(async ([name, file]) => {
      if (
        !name ||
        name.startsWith('.') ||
        name.startsWith('/') ||
        ['react', 'react-dom', 'react-native', 'react-native-web'].includes(name) ||
        typeof file !== 'string'
      ) {
        throw new WebError(
          'INVALID_WEB_CONFIG',
          'Mock a named module with an explicit project-relative file'
        );
      }
      const replacement = await realpath(path.resolve(root, file));
      if (!replacement.startsWith(root + path.sep))
        throw new WebError('OUTSIDE_PROJECT', 'Mock path must be inside the project');
      return { find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement };
    })
  );
}
