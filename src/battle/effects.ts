import {radius, duration, effectLayout} from '../ui/theme';
import {SWAP_ARROW_ICON} from '../ui/icons';
import { AnimatedElement, createAnimatedContainer, createTextElement, createImageContainer, runScheduledCallback } from '../ui/elements';
import {sounds, playSound} from '../services/audio';
import { state } from '../app/state';
import { EasingEaseOut, SideLeft, ItemElementDarkness, SideRight, EasingEaseIn, CurseHeaven, Side, Curse, Guardian, sidePosition } from '../domain/enums';
import {colors, responseTextColor, responseBackgroundColor, elementColor} from '../ui/palette';
import { createItemPriceTooltip, createPurchaseConfirmationDialog, createPurchaseChoiceButton, createCurseCard } from './action-panels';
import type { PlayerStatusPanel } from './player-panels';
import { replaceFirst, parseInteger, replaceAll, invalidState, waitAll } from '../shared/values';
import { createTrainingStatDisplay } from '../ui/stat-widgets';
import { createGuardianArtwork } from '../ui/assets';
import { ArrowIcon } from '../ui/decorative';
import { createCombatCounterDetails } from '../battle/item-details';
import { calculateItemSlotOffset, calculateItemSlotPosition } from '../battle/board';
import { ItemDefinition } from '../domain/models';
const parsePixelValue = (value: string): number => value.length === 0 ? 0 : parseInteger(replaceAll(value, 'px', ''));
export class BattleEffects extends AnimatedElement<HTMLDivElement> {
  constructor(element: HTMLDivElement) {
    super(element);
  }
  async createHitEffect(): Promise<null> {
    playSound(sounds.hit);
    await this.createCombatOutcomeEffect("hit");
    return null;
  }
  async createMissEffect(): Promise<null> {
    playSound(sounds.miss);
    await this.createCombatOutcomeEffect("miss");
    return null;
  }
  async createDarkCloudEffect(): Promise<null> {
    playSound(sounds.darkcloud);
    await this.createCombatOutcomeEffect("darkcloud");
    return null;
  }
  async createCombatOutcomeEffect(effectName: string): Promise<null> {
    let effectContainer = createAnimatedContainer(100, 370, 55, 280);
    let outcomePanel = createAnimatedContainer(100, null, null, 280);
    outcomePanel.setBorderRadius(radius.panel);
    let fontColor: string;
    switch (effectName) {
      case "hit":
        outcomePanel.setBackgroundColor(colors.roseLight);
        outcomePanel.addBorderOverlay(2, colors.redDark);
        fontColor = colors.redDark;
        break;
      case "miss":
        outcomePanel.setBackgroundColor(colors.yellowWhisper);
        outcomePanel.addBorderOverlay(2, colors.text);
        fontColor = colors.text;
        break;
      case "darkcloud":
        outcomePanel.setBackgroundColor(colors.purple);
        fontColor = colors.magentaPale;
        break;
      default:
        throw new Error("Field 'fontColor' has not been initialized.");
    }
    let label = createTextElement(state.translations.getEffectsText(effectName), 100, 10, null, 260);
    label.applyTextStyle(70, fontColor, true);
    label.fitFontSize();
    let outcomeElement = outcomePanel.domElement;
    outcomeElement.append(label.domElement);
    let effectElement = effectContainer.domElement;
    effectElement.append(outcomeElement);
    this.domElement.append(effectElement);
    let verticalOffset = effectName === "miss" ? 50 : -50;
    outcomeElement.style.top = "" + verticalOffset + "px";
    await outcomePanel.animateToPosition({top: 0}, duration.fast, EasingEaseOut);
    await this.animateAsync(duration.normal);
    effectContainer.dispose(0);
    return null;
  }
  async createPrayerEffect(): Promise<null> {
    playSound(sounds.pray);
    await this.createCombatTextEffect("pray", SideLeft);
    return null;
  }
  async createBounceEffect(effectSide: Side): Promise<null> {
    playSound(sounds.bounce);
    await this.createCombatTextEffect("bounce", effectSide);
    return null;
  }
  async createReflectEffect(effectSide: Side): Promise<null> {
    playSound(sounds.reflect);
    await this.createCombatTextEffect("reflect", effectSide);
    return null;
  }
  async createBlockEffect(effectSide: Side): Promise<null> {
    playSound(sounds.block);
    await this.createCombatTextEffect("block", effectSide);
    return null;
  }
  async createSafeEffect(effectSide: Side): Promise<null> {
    playSound(sounds.safe);
    await this.createCombatTextEffect("safe", effectSide);
    return null;
  }
  async createPoorEffect(effectSide: Side): Promise<null> {
    playSound(sounds.poor);
    await this.createCombatTextEffect("poor", effectSide);
    return null;
  }
  async createCombatTextEffect(effectName: string, effectSide: Side): Promise<null> {
    var leftPosition;
    let effectPanel = createAnimatedContainer(150, null, null, 280);
    leftPosition = sidePosition(effectSide!, effectLayout.textLeft, effectLayout.textRight);
    let effectElement = effectPanel.domElement;
    effectElement.style.left = "" + leftPosition + "px";
    effectPanel.setBorderRadius(radius.panel);
    let fontColor: string | null;
    switch (effectName) {
      case "pray":
        effectPanel.setBackgroundColor(colors.teal);
        fontColor = colors.cyanPale;
        break;
      case "safe":
        effectPanel.setBackgroundColor(colors.mintLight);
        effectPanel.addBorderOverlay(5, colors.green);
        fontColor = colors.green;
        break;
      case "poor":
        effectPanel.setBackgroundColor(colors.cream);
        effectPanel.addBorderOverlay(5, colors.rose);
        fontColor = colors.rose;
        break;
      default:
        effectPanel.setBackgroundColor(responseTextColor(effectName));
        fontColor = responseBackgroundColor(effectName);
    }
    let label = createTextElement(state.translations.getEffectsText(effectName), 150, 10, null, 260);
    label.applyTextStyle(80, fontColor!, true);
    label.fitFontSize();
    effectElement.append(label.domElement);
    this.domElement.append(effectElement);
    let isPoor = effectName === "poor";
    let topOffset = isPoor ? 150 : 180;
    effectElement.style.top = "" + topOffset + "px";
    await effectPanel.animateToPosition({top: isPoor ? 200 : 130}, duration.fast, EasingEaseOut);
    await this.animateAsync(duration.slow);
    effectPanel.dispose(0);
    return null;
  }
  async createDamageEffect(damageAmount: number, effectSide: Side | null): Promise<null> {
    playSound(sounds.dealDamage);
    await this.createPlayerDamagePopup(damageAmount, effectSide);
    return null;
  }
  async createDarkDamageEffect(damageAmount: number, effectSide: Side): Promise<null> {
    playSound(sounds.dealDarkDamage);
    await this.createDamagePopup(damageAmount, true, effectSide);
    return null;
  }
  async createDamagePopup(damageAmount: number, darkDamage: boolean, effectSide: Side | null): Promise<null> {
    var leftPosition;
    var travelDistance;
    var holdDuration;
    let effectContainer = createAnimatedContainer(150, null, 130, 280);
    leftPosition = sidePosition(effectSide!, effectLayout.textLeft, effectLayout.textRight);
    let effectElement = effectContainer.domElement;
    effectElement.style.left = "" + leftPosition + "px";
    let damagePanel = createAnimatedContainer(150, null, null, 280);
    damagePanel.setBorderRadius(radius.panel);
    if (darkDamage) {
      damagePanel.setBackgroundColor(elementColor(ItemElementDarkness));
      travelDistance = 500;
      holdDuration = 1250;
    } else {
      damagePanel.setBackgroundColor(colors.text);
      travelDistance = 150;
      holdDuration = 850;
    }
    let damageLabel = createTextElement("" + damageAmount, 120, null, null, damagePanel.getWidth());
    damageLabel.applyTextStyle(100, colors.redDark, true);
    damageLabel.fitFontSize();
    damageLabel.setTextShadow(colors.neutral);
    let damageElement = damagePanel.domElement;
    damageElement.append(damageLabel.domElement);
    let captionLabel = createTextElement(state.translations.getEffectsText("damage"), 50, 20, 100, damagePanel.getWidth() - 40);
    let captionElement = captionLabel.domElement;
    captionElement.style.textAlign = "right";
    captionLabel.applyTextStyle(32, colors.redDark, true);
    captionLabel.fitFontSize();
    captionLabel.setTextShadow(colors.neutral);
    damageElement.append(captionElement);
    effectElement.append(damageElement);
    this.domElement.append(effectElement);
    damageElement.style.top = "" + -150 + "px";
    await damagePanel.animateToPosition({top: 0}, travelDistance, EasingEaseOut);
    await this.animateAsync(holdDuration);
    effectContainer.dispose(0);
    return null;
  }
  createPlayerDamagePopup(damageAmount: number, effectSide: Side | null) {
    return this.createDamagePopup(damageAmount, false, effectSide);
  }
  async createHpBoostEffect(amount: number, effectSide: Side | null): Promise<null> {
    playSound(sounds.boostHp);
    await this.createStatChangePopup("hp", amount, effectSide);
    return null;
  }
  async createMpBoostEffect(amount: number, effectSide: Side): Promise<null> {
    playSound(sounds.boostMp);
    await this.createStatChangePopup("mp", amount, effectSide);
    return null;
  }
  async createCpBoostEffect(amount: number, effectSide: Side): Promise<null> {
    playSound(sounds.boostCp);
    await this.createStatChangePopup("cp", amount, effectSide);
    return null;
  }
  async createStatChangePopup(statName: string, amount: number, effectSide: Side | null): Promise<null> {
    let popup: AnimatedElement;
    if (statName === 'cp') {
      popup = createItemPriceTooltip(amount);
      popup.domElement.style.left = (effectSide!.index === 0 ? '90' : effectSide!.index === 1 ? '430' : 'null') + 'px';
    } else {
      const left = effectSide!.index === 0 ? 30 : effectSide!.index === 1 ? 370 : null;
      popup = createAnimatedContainer(150, left, null, 280);
      popup.setBorderRadius(radius.panel);
      const texts = state.translations;
      let text: string, color: string;
      switch (statName) {
        case 'hp':
          popup.setBackgroundColor(colors.greenBright);
          text = replaceFirst(texts.getEffectsText(statName), '{{hp}}', String(amount));
          color = colors.mintLight;
          break;
        case 'mp':
          popup.setBackgroundColor(colors.periwinkle);
          text = replaceFirst(texts.getEffectsText(statName), '{{mp}}', String(amount));
          color = colors.lavender;
          break;
        default:
          throw new Error("Field 'text' has not been initialized.");
      }
      const label = createTextElement(text, 150, 10, null, popup.getWidth() - 20);
      label.applyTextStyle(80, color, true);
      label.fitFontSize();
      popup.domElement.append(label.domElement);
    }
    this.domElement.append(popup.domElement);
    popup.domElement.style.top = '130px';
    await popup.animateToPosition({top: 80}, duration.long, EasingEaseOut);
    popup.dispose(0);
    return null;
  }
  async createExchangeEffect(player: PlayerStatusPanel, hp: number, mp: number, cp: number): Promise<null> {
    playSound(sounds.exchange);
    let effectContainer = createAnimatedContainer(170, 200, 180, 440);
    let team = player.team;
    let effectElement = effectContainer.domElement;
    effectElement.append(createTrainingStatDisplay(team, player.hp, player.mp, player.cp).domElement);
    this.domElement.append(effectElement);
    {
      await this.animateAsync(duration.normal);
      playSound(sounds.exchange);
      let arrowContainer = globalThis.document.createElement("div");
      new ArrowIcon(arrowContainer).applyElementStyles(arrowContainer, 70, 150, 50, 140);
      let arrowIcon = createImageContainer(SWAP_ARROW_ICON, 70, null, null, 140).domElement;
      arrowIcon.style.color = colors.oliveBright;
      arrowContainer.append(arrowIcon);
      effectElement.append(arrowContainer);
      {
        await this.animateAsync(duration.normal);
        playSound(sounds.exchange);
        let updatedStatsDisplay = createTrainingStatDisplay(team, hp, mp, cp).domElement;
        updatedStatsDisplay.style.top = "120px";
        effectElement.append(updatedStatsDisplay);
        await this.animateAsync(duration.display);
        effectContainer.dispose(0);
        return null;
      }
    }
  }
  async createPurchaseEffect(bought: boolean, effectSide: Side): Promise<null> {
    playSound(sounds.buy);
    let _purchaseConfirmationDialog = createPurchaseConfirmationDialog(false, effectSide);
    let element = _purchaseConfirmationDialog.domElement;
    element.append(createPurchaseChoiceButton(bought).domElement);
    this.domElement.append(element);
    await this.animateAsync(bought ? duration.normal : duration.long);
    _purchaseConfirmationDialog.dispose(0);
    return null;
  }
  async createCpTransferSequence(definition: ItemDefinition, sourceSide: Side, hidden: boolean, destinationSide: Side): Promise<null> {
    runScheduledCallback(this.animateItemTransferBetweenPlayers(definition, sourceSide, hidden, destinationSide));
    await this.createCpTransferEffect(definition.price, destinationSide, !hidden, sourceSide);
    return null;
  }
  createCpTransferSequenceWithoutDarkEffect(definition: ItemDefinition, sourceSide: Side, destinationSide: Side) {
    return this.createCpTransferSequence(definition, sourceSide, false, destinationSide);
  }
  async createCpTransferToOtherSide(amount: number, sourceSide: Side): Promise<null> {
    await this.createCpTransferAnimation(amount, sourceSide, sourceSide === SideLeft ? SideRight : SideLeft);
    return null;
  }
  async createItemAdditionEffect(definition: ItemDefinition): Promise<null> {
    playSound(sounds.addItem);
    await this.animateItemTransferBetweenPlayers(definition, SideLeft, true, SideLeft);
    return null;
  }
  async createCpTransferEffect(amount: number, sourceSide: Side, highlight: boolean, destinationSide: Side): Promise<null> {
    var priceTooltip;
    var destinationLeft;
    var destinationTop;
    if (amount > 0) {
      priceTooltip = createItemPriceTooltip(amount);
      destinationLeft = sidePosition(destinationSide, effectLayout.cpLeft, effectLayout.cpRight);
      let tooltipElement = priceTooltip.domElement;
      tooltipElement.style.left = "" + destinationLeft + "px";
      let tooltipTop = highlight ? 225 : 125;
      tooltipElement.style.top = "" + tooltipTop + "px";
      this.domElement.append(tooltipElement);
      let sourceLeft = null;
      if (destinationSide === sourceSide) {
        destinationTop = highlight ? 100 : null;
      } else {
        sourceLeft = sidePosition(sourceSide, effectLayout.cpLeft, effectLayout.cpRight);
        destinationTop = null;
      }
      await priceTooltip.translateElement(duration.slow, EasingEaseOut, sourceLeft, destinationTop);
    } else {
      await this.animateAsync(duration.slow);
      priceTooltip = null;
    }
    playSound(sounds.moveCp);
    await this.animateAsync(duration.long);
    if (priceTooltip != null) {
      priceTooltip.dispose(0);
    }
    return null;
  }
  createCpTransferAnimation(amount: number, sourceSide: Side, destinationSide: Side) {
    return this.createCpTransferEffect(amount, sourceSide, false, destinationSide);
  }
  async animateItemTransferBetweenPlayers(definition: ItemDefinition, sourceSide: Side, hidden: boolean, destinationSide: Side): Promise<null> {
    var destinationLeft;
    var destinationTop;
    let counter = createCombatCounterDetails(definition, 0, false, 0, null, false, 0, 0);
    destinationLeft = calculateItemSlotPosition(destinationSide);
    let counterElement = counter.domElement;
    counterElement.style.left = "" + destinationLeft + "px";
    let counterTop = hidden ? 260 : 160;
    counterElement.style.top = "" + counterTop + "px";
    this.domElement.append(counterElement);
    let sourceLeft = null;
    if (destinationSide === sourceSide) {
      destinationTop = hidden ? 160 : 260;
    } else {
      sourceLeft = calculateItemSlotPosition(sourceSide);
      destinationTop = null;
    }
    await counter.translateElement(duration.slow, EasingEaseOut, sourceLeft, destinationTop);
    await this.animateAsync(duration.long);
    counter.dispose(0);
    return null;
  }
  createSacrificeOrRemovalEffect(definitions: (ItemDefinition | null)[], hidden: boolean, effectSide: Side) {
    return this.createSacrificeEffect(definitions, hidden, effectSide);
  }
  createSacrificeEffectForPlayer(definitions: (ItemDefinition | null)[], effectSide: Side) {
    return this.createSacrificeOrRemovalEffect(definitions, false, effectSide);
  }
  async createSacrificeEffect(items: (ItemDefinition | null)[], hidden: boolean, effectSide: Side): Promise<null> {
    playSound(hidden ? sounds.sacrifice : sounds.removeItems);
    const leftPosition = calculateItemSlotPosition(effectSide!);
    const effect = createAnimatedContainer(290, leftPosition, 60, 300);
    const effectElement = effect.domElement;
    const counterDetailsList: ReturnType<typeof createCombatCounterDetails>[] = [];
    for (const [itemIndex, itemDefinition] of items.entries()) {
      if (itemDefinition == null) continue;
      const counterDetails = createCombatCounterDetails(itemDefinition, 0, false, 0, null, false, 0, 0);
      const counterElement = counterDetails.domElement;
      counterElement.style.top = "0px";
      const itemWidth = parsePixelValue(counterElement.style.width);
      const itemHeight = parsePixelValue(counterElement.style.height);
      const counterContainer = globalThis.document.createElement("div");
      new AnimatedElement(counterContainer).applyElementStyles(counterContainer, itemHeight, null, null, itemWidth);
      const topOffset = calculateItemSlotOffset(items.length, itemIndex);
      counterContainer.style.top = `${topOffset}px`;
      counterContainer.append(counterElement);
      effectElement.append(counterContainer);
      counterDetailsList.push(counterDetails);
    }
    this.domElement.append(effectElement);
    const animations = counterDetailsList.map(counterDetails => {
      const height = parsePixelValue(counterDetails.domElement.style.height);
      const travelDistance = hidden ? -height : height;
      return counterDetails.animateToPosition({top: travelDistance}, duration.normal, EasingEaseIn);
    });
    await waitAll(animations);
    await this.animateAsync(duration.normal);
    effect.dispose(0);
    return null;
  }
  async createCurseAdditionEffect(curse: Curse, effectSide: Side): Promise<null> {
    var leftPosition;
    playSound(sounds.addCurse);
    let effectContainer = createAnimatedContainer(200, null, 80, 280);
    leftPosition = sidePosition(effectSide!, effectLayout.textLeft, effectLayout.textRight);
    let effectElement = effectContainer.domElement;
    effectElement.style.left = "" + leftPosition + "px";
    let curseCard = createCurseCard(curse);
    let curseElement = curseCard.domElement;
    effectElement.append(curseElement);
    this.domElement.append(effectElement);
    curseElement.style.top = "" + -150 + "px";
    await curseCard.animateToPosition({top: 50}, duration.normal, EasingEaseOut);
    await curseCard.animateToPosition({top: 0}, duration.fast, EasingEaseIn);
    await this.animateAsync(duration.long);
    effectContainer.dispose(0);
    return null;
  }
  async createDiseaseEffect(curse: Curse, effectSide: Side): Promise<null> {
    var leftPosition;
    playSound(sounds.disease);
    let curseCard = createCurseCard(curse);
    leftPosition = sidePosition(effectSide!, effectLayout.textLeft, effectLayout.textRight);
    let curseElement = curseCard.domElement;
    curseElement.style.left = "" + leftPosition + "px";
    curseElement.style.top = "80px";
    this.domElement.append(curseElement);
    await curseCard.animateToPosition({top: 130}, duration.slow, EasingEaseIn);
    curseCard.dispose(0);
    return null;
  }
  async createDiseaseUpgradeEffect(previousCurse: Curse, nextCurse: Curse, natural: boolean, effectSide: Side | null): Promise<null> {
    var leftPosition;
    leftPosition = sidePosition(effectSide!, effectLayout.textLeft, effectLayout.textRight);
    let effectContainer = createAnimatedContainer(150, leftPosition, 130, 280);
    let previousCurseCard = createCurseCard(previousCurse);
    let previousCurseElement = previousCurseCard.domElement;
    previousCurseElement.style.top = "0px";
    let nextCurseCard = createCurseCard(nextCurse);
    let nextCurseElement = nextCurseCard.domElement;
    nextCurseElement.style.top = "" + -150 + "px";
    let effectElement = effectContainer.domElement;
    effectElement.append(previousCurseElement);
    effectElement.append(nextCurseElement);
    this.domElement.append(effectElement);
    if (!natural) {
      await this.animateAsync(duration.normal);
    }
    playSound(sounds.upgradeDisease);
    await waitAll([
      previousCurseCard.animateToPosition({top: 150}, duration.normal, EasingEaseOut),
      nextCurseCard.animateToPosition({top: 0}, duration.normal, EasingEaseOut),
    ]);
    await this.animateAsync(duration.long);
    effectContainer.dispose(0);
    return null;
  }
  async createHeavenUpgradeEffect(natural: boolean, effectSide: Side | null): Promise<null> {
    var leftPosition;
    let effectContainer = createAnimatedContainer(150, null, 130, 280);
    leftPosition = sidePosition(effectSide!, effectLayout.textLeft, effectLayout.textRight);
    let effectElement = effectContainer.domElement;
    effectElement.style.left = "" + leftPosition + "px";
    this.domElement.append(effectElement);
    if (!natural) {
      let heavenCurseCard = createCurseCard(CurseHeaven);
      effectElement.append(heavenCurseCard.domElement);
      await this.animateAsync(duration.normal);
      heavenCurseCard.dispose(0);
    }
    let bannerPanel = createAnimatedContainer(146, 2, 2, 276);
    bannerPanel.setBorderRadius(radius.panel);
    bannerPanel.setBackgroundColor(colors.redBright);
    let bannerLabel = createTextElement(state.translations.getEffectsText("upgradeHeaven"), 150, 10, null, 256);
    bannerLabel.applyTextStyle(80, colors.roseWhisper, true);
    bannerLabel.fitFontSize();
    let bannerElement = bannerPanel.domElement;
    bannerElement.append(bannerLabel.domElement);
    effectElement.append(bannerElement);
    let leftCurseContainer = createAnimatedContainer(75, null, null, 280);
    let leftCurseElement = leftCurseContainer.domElement;
    leftCurseElement.append(createCurseCard(CurseHeaven).domElement);
    leftCurseElement.style.top = "0px";
    let rightCurseContainer = createAnimatedContainer(75, null, 75, 280);
    let rightCurseElement = createCurseCard(CurseHeaven).domElement;
    rightCurseElement.style.top = "" + -75 + "px";
    let rightCurseHost = rightCurseContainer.domElement;
    rightCurseHost.append(rightCurseElement);
    rightCurseHost.style.top = "75px";
    effectElement.append(leftCurseElement);
    effectElement.append(rightCurseHost);
    playSound(sounds.upgradeHeaven);
    await waitAll([
      leftCurseContainer.animateToPosition({top: -75}, duration.slow, null),
      rightCurseContainer.animateToPosition({top: 150}, duration.slow, null),
    ]);
    await this.animateAsync(duration.slow);
    effectContainer.dispose(0);
    return null;
  }
  createCurseRemovalEffectForPlayer(curses: Curse[], effectSide: Side) {
    return this.createCurseRemovalEffect(curses, effectSide);
  }
  async createCurseRemovalEffect(curses: Curse[], side: Side): Promise<null> {
    playSound(sounds.removeCurses);
    const layer = createAnimatedContainer(280, null, 55, 280);
    layer.domElement.style.left = (side.index === 0 ? 30 : side.index === 1 ? 370 : null) + 'px';
    this.domElement.append(layer.domElement);
    const length = curses.length;
    for (const curse of curses) {
      const card = createCurseCard(curse);
      card.domElement.style.top = '130px';
      layer.domElement.append(card.domElement);
      runScheduledCallback(card.animateToPosition({top: -150}, duration.display, EasingEaseIn));
      await this.animateAsync(duration.normal);
      if (curses.length !== length) invalidState(curses);
    }
    await this.animateAsync(duration.display);
    layer.dispose();
    return null;
  }
  async createGuardianSetEffect(guardian: Guardian, effectSide: Side): Promise<null> {
    var leftPosition;
    playSound(sounds.setGuardian);
    let effectContainer = createAnimatedContainer(300, null, 55, 300);
    leftPosition = calculateItemSlotPosition(effectSide!);
    let effectElement = effectContainer.domElement;
    effectElement.style.left = "" + leftPosition + "px";
    let artwork = createGuardianArtwork(guardian, 'large');
    let artworkWidth = artwork.getWidth();
    let artworkContainer = createAnimatedContainer(artwork.getHeight(), null, null, artworkWidth);
    let artworkElement = artworkContainer.domElement;
    artworkElement.append(artwork.domElement);
    artworkElement.style.top = "300px";
    effectElement.append(artworkElement);
    this.domElement.append(effectElement);
    await artworkContainer.animateToPosition({top: 0}, duration.message, EasingEaseOut);
    await this.animateAsync(duration.long);
    effectContainer.dispose(0);
    return null;
  }
  async createGuardianAttackEffect(guardian: Guardian): Promise<null> {
    playSound(sounds.attackByGuardian);
    let effectContainer = createAnimatedContainer(300, 20, 55, 300);
    let artwork = createGuardianArtwork(guardian, 'large');
    let artworkWidth = artwork.getWidth();
    let artworkContainer = createAnimatedContainer(artwork.getHeight(), null, null, artworkWidth);
    let artworkElement = artworkContainer.domElement;
    artworkElement.append(artwork.domElement);
    artworkElement.style.left = "" + -300 + "px";
    let effectElement = effectContainer.domElement;
    effectElement.append(artworkElement);
    this.domElement.append(effectElement);
    await artworkContainer.animateToPosition({left: 0}, duration.normal, EasingEaseOut);
    effectContainer.dispose(0);
    return null;
  }
  async createGuardianRemovalEffect(guardian: Guardian, effectSide: Side | null): Promise<null> {
    var leftPosition;
    playSound(sounds.removeGuardian);
    let effectContainer = createAnimatedContainer(300, null, 55, 300);
    leftPosition = calculateItemSlotPosition(effectSide!);
    let effectElement = effectContainer.domElement;
    effectElement.style.left = "" + leftPosition + "px";
    let artwork = createGuardianArtwork(guardian, 'large');
    let artworkWidth = artwork.getWidth();
    let artworkContainer = createAnimatedContainer(artwork.getHeight(), null, null, artworkWidth);
    let artworkElement = artworkContainer.domElement;
    artworkElement.append(artwork.domElement);
    effectElement.append(artworkElement);
    this.domElement.append(effectElement);
    await artworkContainer.animateToPosition({top: 300}, duration.long, EasingEaseIn);
    await this.animateAsync(duration.normal);
    effectContainer.dispose(0);
    return null;
  }
  async createConfusionEffect(): Promise<null> {
    playSound(sounds.confusion);
    let outerRing = createAnimatedContainer(150, null, null, 280);
    let outerElement = outerRing.domElement;
    outerElement.style.left = "30px";
    outerElement.style.top = "130px";
    outerRing.setBorderRadius(radius.panel);
    outerRing.setBackgroundColor(colors.orange);
    outerRing.addInsetBorderOverlay(10, colors.peach, 10);
    let middleRing = createAnimatedContainer(110, null, null, 240);
    let middleElement = middleRing.domElement;
    middleElement.style.left = "20px";
    middleElement.style.top = "20px";
    middleRing.setBorderRadius(radius.large);
    middleRing.addInsetBorderOverlay(10, colors.peach, 10);
    outerElement.append(middleElement);
    let innerRing = createAnimatedContainer(70, null, null, 200);
    let innerElement = innerRing.domElement;
    innerElement.style.left = "40px";
    innerElement.style.top = "40px";
    innerRing.setBorderRadius(radius.badge);
    innerRing.addInsetBorderOverlay(10, colors.peach, 10);
    outerElement.append(innerElement);
    let label = createTextElement(state.translations.getEffectsText("confusion"), 150, 10, null, 260);
    label.applyTextStyle(80, colors.text, true);
    label.fitFontSize();
    label.setTextShadow(colors.peach);
    outerElement.append(label.domElement);
    this.domElement.append(outerElement);
    await outerRing.animateToPosition({top: 60}, duration.fast, EasingEaseOut);
    await outerRing.animateToPosition({top: 130}, duration.fast, EasingEaseIn);
    await outerRing.animateToPosition({top: 200}, duration.fast, EasingEaseOut);
    await outerRing.animateToPosition({top: 130}, duration.fast, EasingEaseIn);
    outerRing.dispose(0);
    return null;
  }
  async createRedrawEffect(effectSide: Side): Promise<null> {
    var leftPosition;
    playSound(sounds.redraw);
    let effectPanel = createAnimatedContainer(200, null, 105, 280);
    leftPosition = sidePosition(effectSide!, effectLayout.textLeft, effectLayout.textRight);
    let effectElement = effectPanel.domElement;
    effectElement.style.left = "" + leftPosition + "px";
    effectPanel.setBorderRadius(radius.panel);
    effectPanel.setBackgroundColor(colors.peach);
    effectPanel.addBorderOverlay(10, colors.orange);
    let label = createTextElement(state.translations.getEffectsText("redraw"), 200, 10, null, 260);
    label.applyTextStyle(60, colors.cream, true);
    label.fitFontSize();
    label.setTextShadow(colors.orange);
    effectElement.append(label.domElement);
    this.domElement.append(effectElement);
    await effectPanel.animateRectClip(EasingEaseIn, duration.long);
    await this.animateAsync(duration.long);
    effectPanel.dispose(0);
    return null;
  }
  async createDeathEffect(effectSide: Side | null): Promise<null> {
    var leftPosition;
    playSound(sounds.die);
    let effectContainer = createAnimatedContainer(300, null, 55, 300);
    leftPosition = calculateItemSlotPosition(effectSide!);
    let effectElement = effectContainer.domElement;
    effectElement.style.left = "" + leftPosition + "px";
    let deathPanel = createAnimatedContainer(200, null, null, 300);
    deathPanel.setBorderRadius(radius.panel);
    deathPanel.setBackgroundColor(colors.redBright);
    let deathLabel = createTextElement(state.translations.getEffectsText("die"), 200, 10, null, 280);
    deathLabel.applyTextStyle(100, colors.roseWhisper, true);
    deathLabel.fitFontSize();
    deathLabel.setTextShadow(colors.text);
    let deathElement = deathPanel.domElement;
    deathElement.append(deathLabel.domElement);
    deathElement.style.top = "100px";
    effectElement.append(deathElement);
    this.domElement.append(effectElement);
    await deathPanel.animateToPosition({top: -200}, duration.death, EasingEaseIn);
    await this.animateAsync(duration.normal);
    effectContainer.dispose(0);
    return null;
  }
}
