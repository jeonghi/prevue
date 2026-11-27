// Release bundles use this entry. Only the Debug builds load index.preview.
import React from 'react';
import { AppRegistry, Text } from 'react-native';

function App() {
  return React.createElement(Text, null, 'Prevue native fixture');
}
AppRegistry.registerComponent('PrevueNativeFixture', () => App);
