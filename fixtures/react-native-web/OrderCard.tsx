import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePalette } from './theme';

export const sampleOrder = {
  reference: 'SD-2714', origin: '부산', destination: '서울', vehicle: '1톤 카고',
  pickup: '11.27 (금) 09:00', pickupAddress: '부산 사상구', dropoffAddress: '서울 성동구',
};

export interface OrderCardProps {
  order: typeof sampleOrder;
  state?: 'ready' | 'loading' | 'error';
}

export function OrderCard({ order, state = 'ready' }: OrderCardProps) {
  const color = usePalette();
  const [recovered, setRecovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const current = recovered ? 'ready' : state;
  const buttonLabel = current === 'error' ? '다시 시도' : expanded ? '상세 접기' : '상세 보기';

  return (
    <View style={[styles.stage, { backgroundColor: color.canvas }]}>
      <View testID="order-card" style={[styles.card, { backgroundColor: color.surface, borderColor: color.border }]}>
        <View style={styles.row}>
          {current === 'error' ? (
            <View style={[styles.errorMark, { backgroundColor: color.dangerFill }]}>
              <Text style={[styles.mark, { color: color.danger }]}>!</Text>
            </View>
          ) : (
            <View style={[styles.badge, { backgroundColor: current === 'ready' ? color.statusFill : color.canvas }]}>
              <View style={[styles.dot, { backgroundColor: current === 'ready' ? color.status : color.muted }]} />
              <Text style={[styles.badgeText, { color: current === 'ready' ? color.status : color.secondary }]}>
                {current === 'ready' ? '운송 중' : '조회 중'}
              </Text>
            </View>
          )}
          <Text style={[styles.reference, { color: color.muted }]}>{order.reference}</Text>
        </View>
        {current === 'loading' ? (
          <View accessibilityRole="progressbar" accessibilityLabel="운송 정보를 불러오는 중" style={styles.skeleton}>
            <View style={[styles.titleBar, { backgroundColor: color.skeleton }]} />
            <View style={[styles.lineBar, { backgroundColor: color.skeleton }]} />
            <View style={[styles.shortBar, { backgroundColor: color.skeleton }]} />
            <View style={[styles.buttonBar, { backgroundColor: color.canvas }]} />
          </View>
        ) : (
          <>
            {current === 'error' ? (
              <View style={styles.errorBody}>
                <Text accessibilityRole="header" style={[styles.heading, { color: color.ink }]}>불러오기 실패</Text>
                <Text style={[styles.message, { color: color.secondary }]}>다시 시도해 주세요.</Text>
              </View>
            ) : (
              <>
                <Text accessibilityRole="header" style={[styles.heading, { color: color.ink }]}>
                  {order.origin} → {order.destination}
                </Text>
                <View style={[styles.facts, { borderTopColor: color.border }]}>
                  <View style={styles.fact}>
                    <Text style={[styles.label, { color: color.muted }]}>운송 차량</Text>
                    <Text style={[styles.value, { color: color.ink }]}>{order.vehicle}</Text>
                  </View>
                  <View style={styles.fact}>
                    <Text style={[styles.label, { color: color.muted }]}>상차 일시</Text>
                    <Text style={[styles.value, { color: color.ink }]}>{order.pickup}</Text>
                  </View>
                </View>
                {expanded && (
                  <Text testID="order-route-detail" style={[styles.routeDetail, { color: color.secondary }]}>
                    {order.pickupAddress} → {order.dropoffAddress}
                  </Text>
                )}
              </>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={buttonLabel}
              accessibilityState={current === 'ready' ? { expanded } : {}}
              testID={current === 'error' ? 'order-retry' : 'order-detail'}
              onPress={() => current === 'error' ? setRecovered(true) : setExpanded(value => !value)}
              style={({ pressed }) => [styles.button, { backgroundColor: color.accent, opacity: pressed ? 0.84 : 1 }]}
            >
              <Text style={[styles.buttonText, { color: color.onAccent }]}>{buttonLabel}</Text>
              <Text accessible={false} style={[styles.arrow, { color: color.onAccent }]}>{expanded ? '−' : '→'}</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, minHeight: '100%', width: '100%', alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 420, padding: 22, borderRadius: 18, borderWidth: 1, gap: 15 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4 },
  badgeText: { fontSize: 12, fontWeight: '700', lineHeight: 16 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  reference: { fontSize: 11, fontWeight: '700', letterSpacing: 1.1, fontVariant: ['tabular-nums'] },
  heading: { fontSize: 29, fontWeight: '800', letterSpacing: -1, lineHeight: 40 },
  facts: { flexDirection: 'row', gap: 22, borderTopWidth: 1, paddingTop: 13 },
  fact: { gap: 4 },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  value: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  routeDetail: { fontSize: 13, lineHeight: 18 },
  button: { minHeight: 43, borderRadius: 9, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  buttonText: { fontSize: 14, fontWeight: '700' },
  arrow: { fontSize: 19, lineHeight: 23 },
  errorMark: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  mark: { fontSize: 18, fontWeight: '800', lineHeight: 22 },
  errorBody: { minHeight: 95, justifyContent: 'center', gap: 7 },
  message: { fontSize: 15, lineHeight: 21 },
  skeleton: { gap: 9 },
  titleBar: { width: '59%', height: 29, marginBottom: 10, borderRadius: 5 },
  lineBar: { width: '80%', height: 12, borderRadius: 4 },
  shortBar: { width: '51%', height: 12, borderRadius: 4 },
  buttonBar: { height: 43, borderRadius: 9, marginTop: 11 },
});
