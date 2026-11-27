import { createHash } from 'node:crypto';
import { access, glob, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import type { Platform, PreviewDescriptor, Viewport } from './protocol.ts';

const ignored = new Set(['node_modules', 'Pods', 'build', 'dist', 'coverage', 'out']);
const platforms: Platform[] = ['web', 'ios', 'android'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ignoreMissing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
  throw error;
}

async function manifestAt(directory: string): Promise<Record<string, unknown> | undefined> {
  const file = path.join(directory, 'package.json');
  const text = await readFile(file, 'utf8').catch(ignoreMissing);
  if (text === undefined) return undefined;
  try {
    const manifest: unknown = JSON.parse(text);
    if (isRecord(manifest)) return manifest;
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : error}`);
  }
  throw new Error(`${file}: expected a JSON object`);
}

function isNativePackage(manifest?: Record<string, unknown>): boolean {
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(field => {
    const dependencies = manifest?.[field];
    return isRecord(dependencies) && ['react-native', 'expo'].some(name => typeof dependencies[name] === 'string');
  });
}

async function workspacePatterns(directory: string, manifest?: Record<string, unknown>): Promise<string[]> {
  const yaml = await readFile(path.join(directory, 'pnpm-workspace.yaml'), 'utf8').catch(ignoreMissing);
  let patterns: unknown = manifest?.workspaces;
  if (isRecord(patterns)) patterns = patterns.packages;
  if (yaml !== undefined) {
    const config: unknown = parseYaml(yaml);
    patterns = isRecord(config) && 'packages' in config ? config.packages : ['**'];
  }
  if (patterns === undefined) return [];
  if (Array.isArray(patterns) && patterns.every((pattern): pattern is string => typeof pattern === 'string')) {
    return patterns;
  }
  throw new Error(`${directory}: expected workspace package patterns to be an array of strings`);
}

function relativeFile(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function ignoredDirectory(name: string): boolean {
  return ignored.has(name) || name.startsWith('.');
}

async function workspaceApps(directory: string, patterns: string[]): Promise<string[]> {
  const members = patterns.filter(entry => !entry.startsWith('!') && !path.isAbsolute(entry) && !entry.split('/').includes('..'));
  const positive = members.map(entry => path.posix.join(entry, 'package.json'));
  const negative = patterns.filter(entry => entry.startsWith('!')).map(entry => path.posix.normalize(entry.slice(1)));
  const found = new Set<string>();
  for await (const file of glob(positive, { cwd: directory, exclude: name => name.split(path.sep).some(ignoredDirectory) })) {
    const candidate = await realpath(path.resolve(directory, path.dirname(file)));
    const relative = relativeFile(directory, candidate);
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) continue;
    if (negative.some(pattern => path.posix.matchesGlob(relative, pattern))) continue;
    if (!isNativePackage(await manifestAt(candidate))) continue;
    let ancestor = candidate;
    while (ancestor !== directory && !(await hasGitMarker(ancestor))) ancestor = path.dirname(ancestor);
    if (ancestor === directory) found.add(candidate);
  }
  return [...found].sort();
}

async function hasGitMarker(directory: string): Promise<boolean> {
  return (await access(path.join(directory, '.git')).then(() => true).catch(ignoreMissing)) ?? false;
}

/** Locate the owning package without letting an enclosing checkout capture another worktree. */
export async function findProject(target: string): Promise<string> {
  const canonical = await realpath(target);
  let current = (await stat(canonical)).isDirectory() ? canonical : path.dirname(canonical);
  const workspaces: { directory: string; patterns: string[] }[] = [];
  for (;;) {
    const manifest = await manifestAt(current);
    if (isNativePackage(manifest)) return current;
    const patterns = await workspacePatterns(current, manifest);
    if (patterns.length) workspaces.push({ directory: current, patterns });
    const parent = path.dirname(current);
    if (parent === current || await hasGitMarker(current)) break;
    current = parent;
  }
  for (const { directory, patterns } of workspaces) {
    const apps = await workspaceApps(directory, patterns);
    if (apps.length === 1) return apps[0];
    if (apps.length > 1) {
      throw new Error(`Choose a React Native workspace package: ${apps.map(app => relativeFile(directory, app)).join(', ')}`);
    }
  }
  throw new Error(`No React Native or Expo package found for ${target}. Pass a path inside the app.`);
}

type Constants = Map<string, ts.Expression>;

/** Only follow immutable, module-local bindings. Never import or evaluate a preview module. */
function resolveExpression(expression: ts.Expression, constants: Constants): ts.Expression {
  const seen = new Set<ts.Expression>();
  let node = expression;
  while (!seen.has(node)) {
    seen.add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
      node = node.expression;
    } else if (ts.isIdentifier(node) && constants.has(node.text)) {
      node = constants.get(node.text)!;
    } else {
      break;
    }
  }
  return node;
}

function errorAt(source: ts.SourceFile, node: ts.Node, message: string): never {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  throw new Error(`${source.fileName}:${line + 1}:${character + 1}: ${message}`);
}

function objectFields(
  expression: ts.Expression, constants: Constants, source: ts.SourceFile, parents = new Set<ts.Node>(),
): Map<string, ts.Expression> {
  const object = resolveExpression(expression, constants);
  if (!ts.isObjectLiteralExpression(object) || parents.has(object)) {
    errorAt(source, expression, 'Preview metadata must use an object literal or a local const object.');
  }
  const fields = new Map<string, ts.Expression>();
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) {
      for (const [key, value] of objectFields(member.expression, constants, source, new Set([...parents, object]))) {
        fields.set(key, value);
      }
    } else if (ts.isShorthandPropertyAssignment(member)) {
      fields.set(member.name.text, member.name);
    } else if (ts.isPropertyAssignment(member)) {
      const key = ts.isComputedPropertyName(member.name) ? resolveExpression(member.name.expression, constants) : member.name;
      if (!(ts.isIdentifier(key) && !ts.isComputedPropertyName(member.name)) && !ts.isStringLiteralLike(key)) {
        errorAt(source, member.name, 'Preview metadata needs static property names.');
      }
      fields.set(key.text, member.initializer);
    }
  }
  return fields;
}

function readMetadata(
  options: ts.Expression, constants: Constants, source: ts.SourceFile, exportName: string,
): Pick<PreviewDescriptor, 'name' | 'platforms' | 'viewport' | 'theme'> {
  const fields = objectFields(options, constants, source);
  function stringValue(input: ts.Expression, field: string): string {
    const value = resolveExpression(input, constants);
    if (!ts.isStringLiteralLike(value)) errorAt(source, input, `Preview ${field} needs a static string.`);
    return value.text;
  }
  function dimension(input: ts.Expression | undefined, field: string): number {
    const value = input && resolveExpression(input, constants);
    const number = value && ts.isNumericLiteral(value) ? Number(value.text) : NaN;
    if (!Number.isFinite(number) || number <= 0 || (field !== 'pixelRatio' && !Number.isInteger(number))) {
      errorAt(source, input ?? options, `Invalid preview viewport.${field}.`);
    }
    return number;
  }
  const name = fields.has('name') ? stringValue(fields.get('name')!, 'name') : exportName;
  const theme = fields.has('theme') ? stringValue(fields.get('theme')!, 'theme') : undefined;
  if (theme !== undefined && theme !== 'dark' && theme !== 'light') {
    errorAt(source, fields.get('theme')!, 'Preview theme must be light or dark.');
  }
  let available = [...platforms];
  const platformField = fields.get('platforms');
  if (platformField) {
    const value = resolveExpression(platformField, constants);
    if (!ts.isArrayLiteralExpression(value) || !value.elements.length) {
      errorAt(source, platformField, 'Preview platforms must be a nonempty array of web, ios or android.');
    }
    available = [...new Set(value.elements.map(element => {
      const name = stringValue(element, 'platform');
      const platform = platforms.find(item => item === name);
      if (!platform) errorAt(source, element, `Unknown preview platform ${name}.`);
      return platform;
    }))];
  }
  let viewport: Viewport | undefined;
  const viewportField = fields.get('viewport');
  if (viewportField) {
    const size = objectFields(viewportField, constants, source);
    viewport = { width: dimension(size.get('width'), 'width'), height: dimension(size.get('height'), 'height') };
    if (size.has('pixelRatio')) viewport.pixelRatio = dimension(size.get('pixelRatio'), 'pixelRatio');
  }
  return { name, platforms: available, ...(theme && { theme }), ...(viewport && { viewport }) };
}

function previewId(file: string, exportName: string) {
  const hash = createHash('sha256').update(file).update('\0').update(exportName).digest('hex').slice(0, 32);
  return 'rn-' + hash;
}

function exportedPreviews(source: ts.SourceFile, file: string): PreviewDescriptor[] {
  const functions = new Set<string>();
  const namespaces = new Set<string>();
  const constants: Constants = new Map();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === '@prevue/react-native' && !statement.importClause?.isTypeOnly) {
      const names = statement.importClause?.namedBindings;
      if (names && ts.isNamespaceImport(names)) namespaces.add(names.name.text);
      if (names && ts.isNamedImports(names)) {
        for (const spec of names.elements) {
          if (!spec.isTypeOnly && (spec.propertyName ?? spec.name).text === 'definePreview') functions.add(spec.name.text);
        }
      }
    }
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) constants.set(decl.name.text, decl.initializer);
      }
    }
  }

  const descriptors: PreviewDescriptor[] = [];
  function register(exportName: string, declaration: ts.Node, expression: ts.Expression) {
    const call = resolveExpression(expression, constants);
    if (!ts.isCallExpression(call)) return;
    const factory = resolveExpression(call.expression, constants);
    const imported = ts.isIdentifier(factory) && functions.has(factory.text);
    const qualified = ts.isPropertyAccessExpression(factory) && factory.name.text === 'definePreview' &&
      ts.isIdentifier(factory.expression) && namespaces.has(factory.expression.text);
    if (!imported && !qualified) return;
    if (!call.arguments[0]) errorAt(source, call, 'definePreview needs a preview definition.');
    const { line, character } = source.getLineAndCharacterOfPosition(declaration.getStart(source));
    descriptors.push({
      id: previewId(file, exportName), framework: 'react-native',
      source: { file, line: line + 1, column: character + 1, exportName },
      ...readMetadata(call.arguments[0], constants, source, exportName),
    });
  }
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) register(decl.name.text, decl.name, decl.initializer);
      }
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && !statement.isTypeOnly &&
               statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const spec of statement.exportClause.elements) {
        const local = constants.get((spec.propertyName ?? spec.name).text);
        if (local && !spec.isTypeOnly) register(spec.name.text, spec.name, local);
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      register('default', statement.expression, statement.expression);
    }
  }
  return descriptors;
}

function storyDescriptors(source: ts.SourceFile, file: string): PreviewDescriptor[] {
  const names: ts.Identifier[] = [];
  let hasMeta = false;
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) hasMeta = true;
    if (ts.isVariableStatement(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const decl of statement.declarationList.declarations) if (ts.isIdentifier(decl.name)) names.push(decl.name);
    } else if (ts.isFunctionDeclaration(statement) && statement.name && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      names.push(statement.name);
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const spec of statement.exportClause.elements) if (!spec.isTypeOnly && ts.isIdentifier(spec.name)) names.push(spec.name);
    }
  }
  if (!hasMeta) errorAt(source,source,'CSF requires a default meta export.');
  return names.map(node => {
    const exportName = node.text;
    const {line,character} = source.getLineAndCharacterOfPosition(node.getStart(source));
    return {id:previewId(file,exportName), framework:'react-native', format:'csf', name:exportName, platforms:['web'],
      source:{file,line:line+1,column:character+1,exportName}};
  });
}

export async function discover(root: string): Promise<PreviewDescriptor[]> {
  const directory = await realpath(root);
  const files: string[] = [];
  async function walk(folder: string) {
    const entries = await readdir(folder, { withFileTypes: true });
    if (folder !== directory && entries.some(entry => entry.name === '.git')) return;
    for (const entry of entries) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory() && !ignoredDirectory(entry.name)) await walk(target);
      if (entry.isFile() && /\.(?:preview|stories)\.[jt]sx$/.test(entry.name)) files.push(target);
    }
  }
  await walk(directory);
  if (!files.length) return [];

  // TypeScript supplies syntax diagnostics without resolving imports or reading the app's tsconfig.
  const program = ts.createProgram(files.sort(), {
    target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve, allowJs: true, noResolve: true, noLib: true, types: [],
  });
  return files.flatMap(file => {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`Could not read preview source ${file}`);
    const [diagnostic] = program.getSyntacticDiagnostics(source);
    if (diagnostic) {
      const { line, character } = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      throw new Error(`${file}:${line + 1}:${character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    }
    const relative = relativeFile(directory,file);
    return /\.stories\.[jt]sx$/.test(file) ? storyDescriptors(source,relative) : exportedPreviews(source,relative);
  });
}
