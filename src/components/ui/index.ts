/**
 * UI barrel.
 *
 * Screens import from `@/components/ui` rather than reaching into individual
 * files, so the component surface stays explicit and a screen's imports read as a
 * statement of what it uses.
 */

export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { Badge, SegmentedControl, type BadgeTone, type BadgeProps } from './Badge';
export {
  Card,
  DetailRow,
  Divider,
  Screen,
  SectionHeader,
  type ScreenProps,
} from './Card';
export {
  EmptyState,
  ErrorState,
  FatalErrorState,
  ListRowSkeleton,
  LoadingState,
  SetupRequired,
  Skeleton,
  StatSkeleton,
} from './Feedback';
export { SearchBar } from './Controls';
export { Field, Input, TextArea } from './Input';
export { MoneyInput, parseMoneyInput, type MoneyInputProps } from './MoneyInput';
export { NumberInput, type NumberInputProps } from './NumberInput';
export { PasscodeKeypad, type PasscodeKeypadProps } from './PasscodeKeypad';
export { Text, toneColor, type TextProps, type TextTone, type TextVariant } from './Text';