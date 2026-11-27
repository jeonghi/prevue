const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [path.resolve(__dirname, '../../plugin/rn-runtime/packages')],
  resolver: { nodeModulesPaths: [path.join(__dirname, 'node_modules')] },
});
