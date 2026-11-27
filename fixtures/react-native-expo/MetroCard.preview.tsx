import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { definePreview } from '@prevue/react-native';

function MetroCard() {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ padding: 24, flex: 1, backgroundColor: '#e7f4f1' }}>
      <Pressable accessibilityRole="button" testID="metro-details" onPress={() => setExpanded(!expanded)}>
        <Text style={{ fontSize: 24, color: '#125b50' }}>Expo 배송 조회</Text>
      </Pressable>
      {expanded && <Text>대전 → 서울</Text>}
    </View>
  );
}
export const Default = definePreview({ viewport: { width: 320, height: 180 }, render: () => <MetroCard /> });
