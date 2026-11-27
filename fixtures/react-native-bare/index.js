import React from 'react';
import { AppRegistry, Text } from 'react-native';

function Shipment() {
  return React.createElement(Text, { testID: 'ordinary-shipment' }, '일반 운송 화면');
}

AppRegistry.registerComponent('PrevueNativeFixture', () => Shipment);
