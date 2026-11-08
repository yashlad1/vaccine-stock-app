import React from 'react';
import { act, render } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';
import { Loading, LOADING_DELAY_MS } from './components';

/**
 * Loading placeholders (issue 50): nothing before the delay, a pulse after it,
 * and NO pulse (shapes still shown) under Android's "Remove animations".
 */
const setReduceMotion = (on: boolean) =>
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(on);

const shapes = (r: Awaited<ReturnType<typeof render>>) => r.queryAllByTestId('loading-shape', { includeHiddenElements: true }).length;

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function mount(reduce: boolean, shape: 'rows' | 'tiles' = 'tiles') {
  setReduceMotion(reduce);
  const loop = jest.spyOn(Animated, 'loop');
  const r = await render(<Loading label="Loading your vaccines" shape={shape} />);
  await act(async () => {}); // let the reduce-motion promise settle
  return { r, loop };
}

describe('Loading', () => {
  it('shows nothing before the delay, so a fast load never flashes', async () => {
    const { r, loop } = await mount(false);
    await act(async () => { jest.advanceTimersByTime(LOADING_DELAY_MS - 1); });
    expect(shapes(r)).toBe(0);
    expect(loop).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(shapes(r)).toBe(6);
  });

  it('pulses after the delay', async () => {
    const { loop } = await mount(false);
    await act(async () => { jest.advanceTimersByTime(LOADING_DELAY_MS); });
    expect(loop).toHaveBeenCalledTimes(1);
  });

  it('under Remove animations: shapes are shown but do not pulse', async () => {
    const { r, loop } = await mount(true);
    await act(async () => { jest.advanceTimersByTime(LOADING_DELAY_MS + 5000); });
    expect(shapes(r)).toBe(6);
    expect(loop).not.toHaveBeenCalled();
  });

  it('screen readers get one label and the shapes are hidden', async () => {
    const { r } = await mount(false);
    await act(async () => { jest.advanceTimersByTime(LOADING_DELAY_MS); });
    expect(r.getByLabelText('Loading your vaccines')).toBeTruthy();
    expect(r.getByTestId('loading-shapes', { includeHiddenElements: true }).props.importantForAccessibility).toBe('no-hide-descendants');
  });
});
