import 'package:flutter_test/flutter_test.dart';
import 'package:sellflow_flutter/core/money.dart';

void main() {
  group('toMinor', () {
    test('converts major units to minor units', () {
      expect(toMinor('10'), 1000);
      expect(toMinor('10.50'), 1050);
      expect(toMinor('0.01'), 1);
      expect(toMinor('1234.56'), 123456);
    });

    test('tolerates grouping separators and whitespace', () {
      expect(toMinor(' 1,234.56 '), 123456);
    });

    test('accepts non-ASCII digits and normalises them', () {
      expect(toMinor('１２３'), 12300);
      expect(toMinor('٤٥٦'), 45600);
    });

    test('returns null for unusable input rather than coercing to zero', () {
      // A field holding junk must be rejected with a message, never silently
      // become Tk 0 -- that is how an amount gets "recorded" as nothing.
      expect(toMinor(null), isNull);
      expect(toMinor(''), isNull);
      expect(toMinor('abc'), isNull);
      expect(toMinor('.'), isNull);
      expect(toMinor('-'), isNull);
      expect(toMinor('1.2.3'), isNull);
      expect(toMinor('10 taka'), isNull);
    });

    test('rounds half-up beyond the currency precision', () {
      expect(toMinor('10.005'), 1001);
      expect(toMinor('10.004'), 1000);
    });

    test('handles negatives', () {
      expect(toMinor('-10.50'), -1050);
    });
  });

  group('formatMajorUnits', () {
    // This function exists because minor/major units were once confused and every
    // figure was undercounted 100x. These are the regression cases.
    test('divides minor units by 100 for BDT', () {
      expect(formatMajorUnits(1000), 10.0);
      expect(formatMajorUnits(1050), 10.5);
      expect(formatMajorUnits(1), 0.01);
    });
  });

  group('formatMoney', () {
    test('groups thousands', () {
      expect(formatMoney(123456, showSymbol: false), '1,234.56');
      expect(formatMoney(123400, showSymbol: false), '1,234');
    });

    test('respects showDecimals for exact figures', () {
      expect(formatMoney(1050, showSymbol: false), '10.50');
      // showDecimals FORCES the fraction to appear even at zero. It does not strip a
      // non-zero one -- BDT has two decimals, and dropping to '10.5' would present a
      // currency figure with the wrong precision.
      expect(
        formatMoney(1050, showSymbol: false, showDecimals: false),
        '10.50',
      );
      expect(formatMoney(1000, showSymbol: false, showDecimals: false), '10');
      expect(formatMoney(1000, showSymbol: false, showDecimals: true), '10.00');
    });

    test('includes the currency symbol by default', () {
      expect(formatMoney(1050), 'Tk10.50');
    });

    test('renders negatives', () {
      expect(formatMoney(-1050, showSymbol: false), '-10.50');
    });
  });

  group('formatCompactMoney', () {
    test('abbreviates thousands, lakhs and crores', () {
      expect(formatCompactMoney(123400), 'Tk1.2k');
      expect(formatCompactMoney(123456789), 'Tk12.3l');
    });

    test('leaves small amounts alone', () {
      expect(formatCompactMoney(1050), 'Tk10.5');
      expect(formatCompactMoney(1000), 'Tk10');
    });
  });

  group('distribute', () {
    test('never loses the remainder', () {
      // Losing a remainder understates a total, which becomes a visible
      // reconciliation gap once it happens across many splits.
      final parts = distribute(1000, [1, 1, 1]);
      expect(parts.reduce((a, b) => a + b), 1000);
      expect(parts, [333, 333, 334]);
    });

    test('splits proportionally', () {
      expect(distribute(1000, [3, 1]), [750, 250]);
    });

    test('handles a zero total and a single bucket', () {
      expect(distribute(0, [1, 1]), [0, 0]);
      expect(distribute(500, [1]), [500]);
      expect(distribute(500, []), isEmpty);
    });

    test('survives zero weights without dividing by zero', () {
      expect(distribute(100, [0, 0]), [0, 100]);
    });
  });

  group('arithmetic', () {
    test('sums without floating point drift', () {
      // The whole reason Money is int: 0.1 + 0.2 != 0.3 in binary floating point.
      final values = [100, 200, 300];
      expect(sum(values), 600);
      expect(add(1, 2), 3);
      expect(subtract(5, 3), 2);
    });

    test('percentage takes a fraction value', () {
      expect(percentage(1000, 12.5), 125);
      expect(percentage(1000, 0), 0);
    });

    test('clamps to zero', () {
      expect(clampToZero(-1), 0);
      expect(clampToZero(5), 5);
    });

    test('min and max', () {
      expect(min(1, 2), 1);
      expect(max(1, 2), 2);
    });
  });

  group('formatForInput', () {
    test('drops decimals when the amount is whole', () {
      expect(formatForInput(1000), '10');
    });

    test('keeps decimals when they carry value', () {
      expect(formatForInput(1050), '10.50');
    });
  });
}
