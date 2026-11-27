import { useState, type PropsWithChildren } from 'react';
import { Button as NativeButton, FlatList, Modal as NativeModal, ScrollView as NativeScrollView, StyleSheet, Text, TextInput as NativeTextInput, View } from 'react-native';
import { definePreview } from '@prevue/react-native';
import { OrderCard, sampleOrder } from '../OrderCard';
import { DarkProvider, usePalette } from '../theme';

const viewport = { width: 360, height: 320 };
const shipments = [
  { id: 'SD-2714', route: '부산 → 서울', vehicle: '1톤 카고' },
  { id: 'SD-2721', route: '대전 → 인천', vehicle: '2.5톤 윙바디' },
  { id: 'SD-2730', route: '광주 → 수원', vehicle: '1톤 탑차' },
];

function Frame({ title, children }: PropsWithChildren<{ title: string }>) {
  const color = usePalette();
  return (
    <View style={[styles.frame, { backgroundColor: color.surface }]}>
      <Text accessibilityRole="header" style={[styles.title, { color: color.ink }]}>{title}</Text>
      {children}
    </View>
  );
}

function DispatchButton() {
  const [requested, setRequested] = useState(false);
  const color = usePalette();
  return (
    <Frame title="차량 배차">
      <Text style={{ color: color.secondary }}>부산 → 서울 · 1톤 카고</Text>
      <NativeButton testID="dispatch-button" title={requested ? '배차 요청 완료' : '배차 요청'} color={color.accent}
        disabled={requested} onPress={() => setRequested(true)} />
    </Frame>
  );
}

function ShipmentNote() {
  const [note, setNote] = useState('');
  const color = usePalette();
  return (
    <Frame title="기사님께 남길 메모">
      <NativeTextInput testID="shipment-note" accessibilityLabel="화물 메모" placeholder="예: 후문으로 진입해 주세요"
        placeholderTextColor={color.muted} value={note} onChangeText={setNote} maxLength={80} multiline
        style={[styles.input, { borderColor: color.border, color: color.ink }]} />
      <Text testID="note-count" style={{ color: color.secondary }}>{note.length} / 80자</Text>
    </Frame>
  );
}

function ShipmentList({ empty = false }: { empty?: boolean }) {
  const color = usePalette();
  return (
    <Frame title="예정된 운송">
      <FlatList data={empty ? [] : shipments} keyExtractor={item => item.id}
        ListEmptyComponent={<Text style={[styles.empty, { color: color.secondary }]}>아직 예정된 운송이 없어요.</Text>}
        renderItem={({ item }) => (
          <View style={[styles.listRow, { borderColor: color.border }]}>
            <Text style={[styles.route, { color: color.ink }]}>{item.route}</Text>
            <Text style={{ color: color.secondary }}>{item.vehicle} · {item.id}</Text>
          </View>
        )} />
    </Frame>
  );
}

const stops = ['부산 사상구', '양산', '밀양', '대구', '김천', '대전', '천안', '서울 성동구'];

function RouteHistory() {
  const color = usePalette();
  return (
    <Frame title="운송 기록">
      <NativeScrollView testID="route-history" style={styles.history} contentContainerStyle={{ paddingBottom: 10 }}>
        {stops.map((stop, index) => (
          <View key={stop} style={[styles.stop, { borderColor: color.border }]}>
            <Text style={[styles.time, { color: color.status }]}>{String(index + 8).padStart(2, '0')}:00</Text>
            <Text style={[styles.route, { color: color.ink }]}>{stop}</Text>
          </View>
        ))}
      </NativeScrollView>
    </Frame>
  );
}

function DeliveryModal() {
  const [visible, setVisible] = useState(false);
  const color = usePalette();
  const close = () => setVisible(false);
  return (
    <Frame title="도착지 정보">
      <Text style={{ color: color.secondary }}>서울 성동구</Text>
      <NativeButton title="인수 안내 열기" testID="open-modal" color={color.accent} onPress={() => setVisible(true)} />
      <NativeModal visible={visible} transparent animationType="none" onRequestClose={close}>
        <View style={styles.overlay}>
          <View style={[styles.dialog, { backgroundColor: color.surface }]}>
            <Text style={[styles.route, { color: color.ink }]}>인수 안내</Text>
            <Text style={{ color: color.secondary }}>도착 후 1층 물류 데스크에서 서명해 주세요.</Text>
            <NativeButton title="닫기" testID="close-modal" color={color.accent} onPress={close} />
          </View>
        </View>
      </NativeModal>
    </Frame>
  );
}

function ShipmentNavigation() {
  const [selectedId, navigate] = useState<string | null>(null);
  const color = usePalette();
  const selected = shipments.find(item => item.id === selectedId);
  if (selected) {
    return (
      <Frame title={selected.route}>
        <Text style={{ color: color.secondary }}>{selected.vehicle} · {selected.id}</Text>
        <NativeButton title="목록으로 돌아가기" testID="navigation-back" color={color.accent} onPress={() => navigate(null)} />
      </Frame>
    );
  }
  return (
    <Frame title="운송 목록">
      {shipments.map(item => (
        <NativeButton key={item.id} title={item.route} color={color.accent} onPress={() => navigate(item.id)} />
      ))}
    </Frame>
  );
}

export const Button = definePreview({ viewport, render: () => <DispatchButton /> });
export const TextInput = definePreview({ viewport, render: () => <ShipmentNote /> });
export const List = definePreview({ viewport, render: () => <ShipmentList /> });
export const ScrollView = definePreview({ viewport, render: () => <RouteHistory /> });
export const Modal = definePreview({ viewport, render: () => <DeliveryModal /> });
export const Empty = definePreview({ viewport, render: () => <ShipmentList empty /> });
export const Dark = definePreview({
  viewport, theme: 'dark', provider: DarkProvider,
  render: () => <OrderCard order={sampleOrder} />,
});
export const Navigation = definePreview({ viewport, render: () => <ShipmentNavigation /> });

const styles = StyleSheet.create({
  frame: { minHeight: '100%', width: '100%', flex: 1, gap: 16, padding: 22 },
  title: { fontSize: 24, fontWeight: '800', lineHeight: 33, letterSpacing: -0.7 },
  input: { minHeight: 85, padding: 13, borderWidth: 1, borderRadius: 9, fontSize: 15, textAlignVertical: 'top' },
  listRow: { paddingVertical: 12, borderBottomWidth: 1, gap: 4 },
  route: { fontSize: 16, lineHeight: 23, fontWeight: '700' },
  empty: { paddingVertical: 30, textAlign: 'center', fontSize: 15 },
  history: { maxHeight: 210 },
  stop: { minHeight: 53, flexDirection: 'row', alignItems: 'center', gap: 22, borderBottomWidth: 1 },
  time: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  overlay: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(12, 31, 43, 0.45)' },
  dialog: { padding: 20, gap: 17, borderRadius: 14 },
});
