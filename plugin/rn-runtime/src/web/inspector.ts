import { randomUUID } from 'node:crypto';
import { transformAsync, types as t, type NodePath, type PluginObj } from '@babel/core';
import type { Plugin } from 'vite';
import type { Source, UINode } from '../protocol.ts';
import type { BrowserNode, BrowserTree } from './bridge.ts';

type Host = { name: string; source: Source };
export interface SourceIndex {
  attribute: string;
  lookup(token: string): Host | undefined;
}

// These host components forward dataSet to their own rendered DOM element.
const hosts = new Set(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'Image']);

function hostName(path: NodePath<t.JSXOpeningElement>): string | undefined {
  const tag = path.node.name;
  if (t.isJSXIdentifier(tag) && t.react.isCompatTag(tag.name)) return;
  const namespace = t.isJSXMemberExpression(tag) && t.isJSXIdentifier(tag.object) ? tag.object.name : undefined;
  const local = t.isJSXIdentifier(tag) ? tag.name : namespace;
  if (!local) return;
  const binding = path.scope.getBinding(local)?.path;
  if (!binding?.parentPath?.isImportDeclaration() || binding.parentPath.node.source.value !== 'react-native' ||
      binding.parentPath.node.importKind === 'type') return;
  if (t.isJSXMemberExpression(tag) && namespace && binding.isImportNamespaceSpecifier()) return tag.property.name;
  if (!t.isJSXIdentifier(tag) || !binding.isImportSpecifier() || binding.node.importKind === 'type') return;
  const imported = binding.node.imported;
  return t.isIdentifier(imported) ? imported.name : imported.value;
}

export function createHostInspector() {
  const nonce = randomUUID().replaceAll('-', '');
  const marker = '__prevueHost' + nonce;
  const dataKey = 'prevue-host-' + nonce;
  const ids = new Map<string, number>();
  const modules = new Map<number, Map<string, Host>>();
  const index: SourceIndex = {
    attribute: 'data-' + dataKey,
    lookup(token) { return modules.get(Number(token.split('.')[0]))?.get(token); },
  };
  function invalidate(file: string) {
    const id = ids.get(file);
    if (id !== undefined) modules.delete(id);
  }

  function authorLocations(file: string): PluginObj {
    const id = ids.get(file) ?? ids.size;
    ids.set(file, id);
    const locations = new Map<string, Host>();
    return {
      name: 'prevue-rn-host-locations',
      post() { modules.set(id, locations); },
      visitor: {
        JSXOpeningElement(path) {
          const name = hostName(path);
          const start = path.node.loc?.start;
          if (!name || !hosts.has(name) || !start) return;
          const token = [id, start.line, start.column, name].join('.');
          locations.set(token, { name, source: { file, line: start.line, column: start.column + 1 } });
          path.node.attributes.push(t.jsxAttribute(t.jsxIdentifier(marker), t.stringLiteral(token)));
        },
      },
    };
  }

  const dataSets: Plugin = {
    name: 'prevue-rn-host-data-set',
    enforce: 'post',
    async transform(code, filename) {
      if (!code.includes(marker)) return;
      let helper: t.Identifier | undefined;
      const attach: PluginObj = {
        visitor: {
          CallExpression: {
            exit(path) {
              const props = path.node.arguments[1];
              if (!t.isObjectExpression(props)) return;
              const property = props.properties.find(prop => t.isObjectProperty(prop) &&
                (t.isIdentifier(prop.key, { name: marker }) || t.isStringLiteral(prop.key, { value: marker })));
              if (!t.isObjectProperty(property) || !t.isStringLiteral(property.value) || !index.lookup(property.value.value)) return;
              props.properties = props.properties.filter(prop => prop !== property);
              helper ??= path.scope.getProgramParent().generateUidIdentifier('prevueHostProps');
              path.node.arguments[1] = t.callExpression(t.cloneNode(helper), [props, property.value]);
            },
          },
        },
      };
      // JSX has already resolved attribute order, spreads, key and ref. Merge the
      // marker into the final props object so project data/getters are read once.
      const output = await transformAsync(code, { filename, babelrc: false, configFile: false, plugins: [attach], sourceMaps: true, retainLines: true });
      if (!helper || !output?.code) return;
      const key = JSON.stringify(dataKey);
      const merge = '\nfunction ' + helper.name + '(props, token) {\n' +
        '  if (!Object.prototype.hasOwnProperty.call(props.dataSet ?? {}, ' + key + ')) {\n' +
        '    props.dataSet = { ...props.dataSet, [' + key + ']: token };\n  }\n  return props;\n}\n';
      return { code: output.code + merge, map: output.map };
    },
  };
  return { index, authorLocations, invalidate, dataSets };
}

export function resolveSources(tree: BrowserTree, index?: SourceIndex) {
  function resolve(node: BrowserNode): UINode {
    const { sourceToken, children, ...rest } = node;
    const host = sourceToken && index?.lookup(sourceToken);
    return { ...rest, name: host ? host.name : node.name, source: host ? host.source : null, children: children.map(resolve) };
  }
  return { width: tree.width, height: tree.height, nodes: tree.nodes.map(resolve) };
}
