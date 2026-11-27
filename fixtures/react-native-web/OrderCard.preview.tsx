import { definePreview } from '@prevue/react-native';
import { OrderCard, sampleOrder, type OrderCardProps } from './OrderCard';

const viewport = { width: 360, height: 320 };

export const Default = definePreview<OrderCardProps>({
  name: 'Default', viewport,
  props: { order: sampleOrder },
  render: props => <OrderCard {...props} />,
});

export const Loading = definePreview<OrderCardProps>({
  name: 'Loading', viewport,
  props: { order: sampleOrder, state: 'loading' },
  render: props => <OrderCard {...props} />,
});

export const Error = definePreview<OrderCardProps>({
  name: 'Error', viewport,
  props: { order: sampleOrder, state: 'error' },
  render: props => <OrderCard {...props} />,
});
