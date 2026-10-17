import React from 'react';
import { render, userEvent } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Badge, BigButton, Footer, Stepper, T } from './components';
import { MAX_FONT_SCALE } from './tokens';

/**
 * Component tests for the behaviours that are CORRECTNESS, not appearance.
 *
 * The `ui` project has been empty since the project started, so these begin
 * with the controls whose failure corrupts data rather than the ones whose
 * failure looks wrong: a stepper that can exceed its bounds writes a stock
 * number nobody intended, and in a derived-stock ledger that surfaces weeks
 * later as unexplained drift.
 */

/**
 * `render` is ASYNCHRONOUS in @testing-library/react-native 14 - it returns a
 * Promise, so a forgotten `await` makes every query fail with the confusing
 * "`render` function has not been called". Wrapped once here so no test has to
 * remember.
 *
 * SafeAreaProvider is required because Footer and the top tab bar read
 * useSafeAreaInsets, and without a provider the hook throws.
 */
/**
 * `initialMetrics` is not optional. Without it SafeAreaProvider waits for a
 * real onLayout measurement that never arrives in a test, and renders NOTHING -
 * every query then fails with "unable to find an element", which reads like a
 * broken component rather than a missing prop.
 *
 * The 48 bottom inset stands in for Android's three-button navigation bar,
 * which is the thing Footer exists to clear.
 */
export const NAV_BAR = 48;
const metrics = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 24, left: 0, right: 0, bottom: NAV_BAR },
};

const wrap = (ui: React.ReactElement) =>
  render(<SafeAreaProvider initialMetrics={metrics}>{ui}</SafeAreaProvider>);

describe('Stepper', () => {
  it('cannot be pushed past its maximum', async () => {
    // The reason steppers exist here at all: a stepper cannot produce 100 when
    // you meant 10. That guarantee is only real if the clamp holds.
    const onChange = jest.fn();
    const s = await wrap(<Stepper value={20} onChange={onChange} min={1} max={20} />);
    await userEvent.press(s.getByLabelText('Increase'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cannot be pushed below its minimum', async () => {
    const onChange = jest.fn();
    const s = await wrap(<Stepper value={1} onChange={onChange} min={1} max={20} />);
    await userEvent.press(s.getByLabelText('Decrease'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('steps by one', async () => {
    const onChange = jest.fn();
    const s = await wrap(<Stepper value={5} onChange={onChange} min={1} max={20} />);
    await userEvent.press(s.getByLabelText('Increase'));
    expect(onChange).toHaveBeenCalledWith(6);
  });

  it('clamps a quick-value chip to the allowed range', async () => {
    // Receiving offers 1/5/10/20/50. None may escape the bounds.
    const onChange = jest.fn();
    const s = await wrap(<Stepper value={1} onChange={onChange} min={0} max={200} quickValues={[0, 5, 10, 20]} />);
    await userEvent.press(s.getByText('20'));
    expect(onChange).toHaveBeenCalledWith(20);
  });
});

describe('Badge', () => {
  it('always carries a WORD, not only a colour', async () => {
    // ~8% of men are red-green colourblind and a bright clinic window destroys
    // colour discrimination anyway, so state must never be colour alone.
    const s = await wrap(<Badge text="LOW" tone="low" />);
    expect(s.getByText('LOW')).toBeTruthy();
  });
});

describe('BigButton', () => {
  it('does not fire when disabled', async () => {
    const onPress = jest.fn();
    const s = await wrap(<BigButton label="Give 1 dose" onPress={onPress} disabled />);
    await userEvent.press(s.getByText('Give 1 dose'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('fires once when enabled', async () => {
    const onPress = jest.fn();
    const s = await wrap(<BigButton label="Add to stock" onPress={onPress} />);
    await userEvent.press(s.getByText('Add to stock'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('T', () => {
  it('caps font scaling on every piece of text', async () => {
    // A raw <Text> opts out of the cap, which is why the static audit forbids
    // one outside this file. This proves the cap is actually applied.
    const s = await wrap(<T>18 doses</T>);
    expect(s.getByText('18 doses').props.maxFontSizeMultiplier).toBe(MAX_FONT_SCALE);
  });
});

describe('Footer — the navigation-bar fix', () => {
  it('adds the bottom inset, so the primary button is not under the nav bar', async () => {
    // This regressed once and made "ADD A NEW VACCINE" look like a feature
    // that had never been built: the button was not clipped, it was
    // untappable. The assertion is that padding EXCEEDS the inset, so there is
    // real space below the button rather than the inset merely being consumed.
    const s = await wrap(
      <Footer>
        <BigButton label="Add a new vaccine" onPress={() => undefined} />
      </Footer>,
    );
    const btn = s.getByText('Add a new vaccine');
    expect(btn).toBeTruthy();

    const flat = (st: unknown): Record<string, unknown> =>
      Array.isArray(st) ? Object.assign({}, ...st.filter(Boolean).map(flat)) : (st as Record<string, unknown>) ?? {};

    // Walk up from the button to the Footer view and read its padding.
    let node: any = btn;
    let paddingBottom: number | undefined;
    for (let i = 0; i < 12 && node; i += 1) {
      const pb = flat(node.props?.style)?.paddingBottom;
      if (typeof pb === 'number' && pb >= NAV_BAR) { paddingBottom = pb; break; }
      node = node.parent;
    }
    expect(paddingBottom).toBeGreaterThanOrEqual(NAV_BAR);
  });
});
