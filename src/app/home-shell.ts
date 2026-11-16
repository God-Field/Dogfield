import {radius, screen} from '../ui/theme';
import {colors} from '../ui/palette';
import {createTextElement} from '../ui/elements';
import {createItemReferenceMenu, createReferenceButton} from '../reference/menu';
import {createVolumeControl} from '../ui/audio-controls';
import {TextAlignmentLeft} from '../domain/enums';
import {createFullScreenPanel} from '../ui/panels';
import {HomePage} from './home-page';
import {registerApplication} from './runtime';

export function createHomePage(): HomePage {
  const header = createFullScreenPanel();
  const footer = createFullScreenPanel();
  const title = createTextElement('', 24, 130, 4, 330);
  const subtitle = createTextElement('', 30, 10, null, 200);
  const reference = createItemReferenceMenu();
  const element = document.createElement('div');
  const homePage = new HomePage(header, footer, title, subtitle, reference, element);
  homePage.applyElementStyles(element, screen.homeHeight, null, null, screen.width);
  title.setBorderRadius(radius.small);
  title.setBackgroundColor(colors.brand);
  title.setTextAlignment(TextAlignmentLeft);
  title.applyTextStyle(22, colors.mintLight, true);
  header.append(title);
  header.append(createReferenceButton());
  homePage.append(header);
  footer.setTop(690);
  subtitle.setHeightLeftWidth(30, 10, 200);
  subtitle.applyNormalTextStyle(20, colors.mintLight);
  footer.append(subtitle);
  footer.append(createVolumeControl());
  homePage.append(footer);
  registerApplication(homePage);
  return homePage;
}
