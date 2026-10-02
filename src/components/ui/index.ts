/**
 * UI barrel.
 *
 * Screens import from `@/components/ui` rather than reaching into individual
 * files, so the component surface stays explicit.
 */

export {
  Amount,
  AmountRow,
  CountMetric,
  CountRow,
  Metric,
  RatioMetric,
  currencySymbol,
} from './Amount';
export { Badge, OrderStatusBadge, PaymentStatusBadge, STATUS_FLOW, statusLabel } from './Badge';
export { Button, type ButtonProps, type ButtonVariant } from './Button';
export { Card, DetailRow, Divider, SectionHeader } from './Card';
export { FilterChip, SearchBar, SegmentedControl, useDebouncedValue, type SegmentOption } from './Controls';
export { Banner, ErrorBanner, confirm, confirmDestructive } from './Dialog';
export { BottomSheet } from './BottomSheet';
export { EmptyState, ErrorState, ListRowSkeleton, LoadingState, SetupRequired, Skeleton, StatSkeleton } from './Feedback';
export { Field, Input, SelectField, TextArea } from './Input';
export { Avatar, ListRow, RowIcon } from './ListRow';
export { ListScreen, Screen } from './Screen';
export { Text, type TextProps } from './Text';
