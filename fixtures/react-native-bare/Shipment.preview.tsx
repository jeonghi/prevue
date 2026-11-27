import React, { useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { definePreview } from '@prevue/react-native';

const waypoints = Array.from({ length: 24 }, (_, index) => `경유지 ${index + 1}`);
const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, paddingVertical: 72, gap: 18 },
  heading: { fontSize: 26 },
  field: { borderWidth: 1, padding: 10 },
});

function Shipment() {
  const [sent, setSent] = useState(false);
  const [note, setNote] = useState('');
  return (
    <ScrollView testID="route-history" contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.heading}>부산 → 서울</Text>
      <Text testID="shipment-status">{sent ? '배차 요청 완료' : '1톤 카고'}</Text>
      <Button testID="dispatch-button" title="배차 요청" onPress={() => setSent(true)} />
      <TextInput testID="shipment-note" accessibilityLabel="화물 메모" placeholder="화물 메모"
        value={note} onChangeText={setNote} style={styles.field} />
      <Text testID="receipt">{note}</Text>
      {waypoints.map(waypoint => <Text key={waypoint}>{waypoint}</Text>)}
    </ScrollView>
  );
}

export const Default = definePreview({ name: '운송 요청', platforms: ['ios', 'android'], render: () => <Shipment /> });
