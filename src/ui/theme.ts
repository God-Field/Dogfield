
export const screen = {
  width: 1080,
  height: 660,
  homeHeight: 720,
  battleWidth: 680,
  battleHeight: 405,
  contentWidth: 660,
} as const;

export const duration = {
  instant: 0,
  fast: 250,
  normal: 500,
  slow: 750,
  long: 1000,
  display: 1500,
  message: 2000,
  death: 2500,
  roomTimeout: 10000,
  chatScroll: 12000,
} as const;

export const timestampWindow = {
  /** Microseconds; matches the original history and room-activity windows. */
  restore: 300000000,
  chatHistory: 2000000,
  roomActivity: 200000000,
} as const;

export const surfaceSize = {
  dialog: {height: 300, width: 480},
  action: {height: 100, width: 440},
  detail: {height: 90, width: 300},
  itemRow: {height: 30, width: 280},
  headerButton: {height: 24, width: 180},
  headerLabel: {height: 24, width: 100},
  menuPanel: {height: 380, width: 480},
  purchaseChoice: {height: 90, width: 300},
  playerRow: {height: 70, width: 200},
  playerOption: {height: 70, width: 140},
  settingsAction: {height: 40, width: 400},
  smallBadge: {height: 20, width: 120},
  smallPill: {height: 24, width: 120},
  priceBadge: {height: 44, width: 44},
  priceTooltip: {height: 160, width: 160},
  curseCard: {height: 150, width: 280},
  toast: {height: 50, width: 650},
  commandPanel: {height: 40, width: 260},
  commandButton: {height: 300, width: 310},
  itemButton: {height: 40, width: 80},
  selectionBadge: {height: 20, width: 20},
  detailBadge: {height: 22, width: 80},
  usedMiracles: {height: 40, width: 250},
  ratingBadge: {height: 90, width: 480},
  stepper: {height: 50, width: 120},
  flashEffect: {height: 190, width: 300},
  endingBanner: {height: 100, width: 640},
  modeCard: {height: 200, width: 500},
  nameAction: {height: 90, width: 480},
  targetIndicator: {height: 60, width: 60},
  chatBadge: {height: 24, width: 160},
  rankingRow: {height: 30, width: 530},
  tiebreakChoice: {height: 50, width: 200},
  costBadge: {height: 42, width: 50},
  playerCountButton: {height: 100, width: 600},
  settingsHeader: {height: 80, width: 400},
  summaryValue: {height: 80, width: 290},
  purchaseDialog: {height: 290, width: 300},
  greenLabel: {height: 60, width: 200},
  modeCount: {height: 50, width: 480},
  drawTiebreak: {height: 70, width: 200},
  chatBar: {height: 30, width: 470},
  nameEditor: {height: 190, width: 480},
} as const;

export const itemLayout = {
  commandHeight: 100,
  commandWidth: 80,
  giftOffset: 80,
  detailBadgeTop: 78,
  rowStep: 82,
  firstRowTop: 88,
  wrappedRowTop: 190,
  detailHeight: 21,
  detailLeft: 1,
  detailTop: 3,
  detailWidth: 78,
} as const;

export const effectLayout = {
  textLeft: 30,
  textRight: 370,
  cpLeft: 90,
  cpRight: 430,
} as const;

export const referenceLayout = {
  pageLeft: 250,
  pageWidth: 820,
  gridHeight: 530,
  gridLeft: 10,
  gridTop: 115,
  gridWidth: 800,
  cellSize: 80,
  cellStep: 85,
  ratesHeight: 90,
  ratesTop: 15,
  previewHeight: 400,
  previewLeft: 460,
  previewTop: 115,
  previewWidth: 300,
} as const;

export const chatLayout = {
  historyOffset: 120,
  logLeft: 500,
  logWidth: 580,
  backgroundLeft: 10,
  backgroundWidth: 560,
  messageHeight: 100,
  messageWidth: 1060,
  inputHeight: 24,
  inputLeft: 5,
  inputTop: 3,
  inputWidth: 280,
  panelHeight: 30,
  panelLeft: 210,
  panelWidth: 680,
  badgeIconLeft: 15,
  badgeIconTop: 3,
  badgeIconSize: 24,
  badgeTextLeft: 42,
  badgeTextTop: 3,
  badgeTextWidth: 123,
  badgeBackgroundLeft: 10,
  badgeBackgroundTop: 3,
  badgeBackgroundWidth: 160,
} as const;

export const battleLayout = {
  playerRoster: {height: 400, left: 680, width: 390},
  statusRow: {height: 40, width: 390},
  itemPanel: {height: 292, left: 10, top: 367, width: 736},
  commandOverlay: {height: 20, top: 420},
  userList: {height: 132, left: 825, top: 528, width: 245},
  lockToggle: {height: 30, left: 890, width: 30},
} as const;

export const radius = {
  small: 5,
  medium: 10,
  smallBadge: 12,
  tiebreak: 14,
  badge: 15,
  large: 20,
  price: 22,
  panel: 25,
  round: 40,
  pill: 80,
} as const;

export const opacity = {
  hidden: 0,
  faint: 0.25,
  disabled: 0.4,
  disabledOverlay: 0.5,
  dim: 0.75,
  placeholder: 0.65,
  visible: 1,
} as const;

export const layer = {
  base: '0',
  raised: '1',
  overlay: '2',
} as const;
