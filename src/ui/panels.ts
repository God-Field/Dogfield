import {radius, screen} from './theme';
import {colors} from './palette';
import {FullScreenPanel, MessageBar} from './decorative';

export function createFullScreenPanel(): FullScreenPanel {
  const element = document.createElement('div');
  const panel = new FullScreenPanel(element);
  panel.applySurface({height: 30, width: screen.width, background: colors.brand});
  return panel;
}

export function createMessageBar(input: string, isEnabled: boolean): MessageBar {
  const width = isEnabled ? 380 : 480;
  const element = document.createElement('div');
  const messageBar = new MessageBar(element);
  messageBar.renderCard({
    height: 90, width, radius: radius.large,
    background: colors.creamYellow,
    border: {width: 4, color: colors.tan},
    label: {
      text: input, height: 90, left: 10, top: null, width: width - 20,
      size: 60, color: colors.text, bold: true, fit: true
    }
  });
  messageBar.initializeClickable();
  return messageBar;
}
