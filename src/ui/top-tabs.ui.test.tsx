import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TopTabBar } from './top-tabs';

const metrics = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 24, left: 0, right: 0, bottom: 0 },
};

const routes = ['index', 'stock', 'vaccines', 'trends', 'more'].map((name) => ({ key: name, name }));
const props: React.ComponentProps<typeof TopTabBar> = {
  state: { index: 0, routes },
  descriptors: Object.fromEntries(routes.map((r) => [r.key, { options: { title: r.name } }])),
  navigation: { emit: jest.fn(() => ({ defaultPrevented: false })), navigate: jest.fn() },
} as never;

describe('TopTabBar', () => {
  it('has no fixed width on the scroll content, or Android cannot scroll to the last tab', async () => {
    const s = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <TopTabBar {...props} />
      </SafeAreaProvider>,
    );
    // tab -> content view -> the scroll view host, which carries contentContainerStyle.
    const scroll = s.getByLabelText('index').parent?.parent;
    const style = StyleSheet.flatten(scroll?.props.contentContainerStyle);
    expect(style.width).toBeUndefined();
    expect(style.maxWidth).toBeUndefined();
    expect(style.minWidth).toBe('100%');
  });
});
