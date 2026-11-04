import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Animated, Pressable, Text } from 'react-native';
import { ToastProvider, useToast } from './snackbar';

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(() => Promise.resolve()),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));

const metrics = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 24, left: 0, right: 0, bottom: 48 },
};

function Buttons() {
  const t = useToast();
  return (
    <>
      <Pressable accessibilityLabel="ok" onPress={() => t.show('Saved')}>
        <Text>ok</Text>
      </Pressable>
      <Pressable accessibilityLabel="err" onPress={() => t.showError('Could not undo')}>
        <Text>err</Text>
      </Pressable>
    </>
  );
}

describe('toast', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // The jest Animated runs fades to completion at once, so a fade interrupted
  // part-way cannot happen for real. This stand-in behaves like the device:
  // a fade runs for its duration, and stopping it reports finished = false.
  beforeEach(() => {
    // Like the real driver, starting a fade stops the one already running.
    let running: { stop: () => void } | undefined;
    jest.spyOn(Animated, 'timing').mockImplementation(((_v: unknown, cfg: { duration: number }) => {
      let cb: ((r: { finished: boolean }) => void) | undefined;
      let t: ReturnType<typeof setTimeout>;
      const anim = {
        start: (done?: (r: { finished: boolean }) => void) => {
          running?.stop();
          running = anim;
          cb = done;
          t = setTimeout(() => cb?.({ finished: true }), cfg.duration);
        },
        stop: () => {
          clearTimeout(t);
          cb?.({ finished: false });
        },
      };
      return anim;
    }) as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('an error shown during the fade-out of an earlier toast stays on screen', async () => {
    const s = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>
          <Buttons />
        </ToastProvider>
      </SafeAreaProvider>,
    );
    await fireEvent.press(s.getByLabelText('ok'));
    await act(async () => {
      jest.advanceTimersByTime(3500 + 50);
    }); // hide() fade has begun
    await fireEvent.press(s.getByLabelText('err'));
    await act(async () => {
      jest.advanceTimersByTime(500);
    }); // the old fade's callback would fire here
    expect(s.getByText('Could not undo')).toBeTruthy();
  });
});
