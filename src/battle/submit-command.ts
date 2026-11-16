import {MAX_ITEM_SLOTS} from '../domain/constants';
import {roomAction} from '../services/protocol';
import type { CommandRules } from './command-rules';
import { getApplication } from '../app/runtime';
import { RoomController } from '../rooms/room-controller';
import { SideLeft, SideRight } from '../domain/enums';
import { ItemSlot } from '../domain/models';
import { createCommandPayload } from '../engine/battle-engine';
import { validateItemAction } from '../engine/validation';
import {sounds, playSound} from '../services/audio';
export function submitItemActionCommand(rules: CommandRules): () => Promise<null> {
  return async () => {
    const page = rules.page,
      players = page.playerRoster,
      application = getApplication(),
      selected = rules.selectedItems;
    const availableMp = players.findPlayerStatById(application.userId)!.mp;
    const alert = validateItemAction({
      models: selected.map(item => item.getItemModel()),
      availableMp,
      mode: rules.isDefending ? 'defense' : 'normal',
      hasSpecialItemCommand: !rules.isDefending && selected.length === 0 && page.itemPanel.hasSpecialItemCommand(),
    });
    if (alert !== null) {
      rules.getCommandAlert(alert);
      return null;
    }
    playSound(sounds.command);
    page.commandOverlay.hideItemCommandOverlay();
    rules.setItemActionControl(null);
    const board = page.board,
      primary = board.isReversed ? SideRight : SideLeft,
      opposite = primary === SideLeft ? SideRight : SideLeft,
      items = page.itemPanel;
    if (rules.isDefending) {
      board.clearPlayerSideItems(opposite);
      board.setPlayerSideOverlay(opposite, null);
      items.refreshItemCommandSelection();
      if (selected.length !== 0) items.resetItemArrangement(0);
    } else {
      board.setPlayerBoardBadgeWithoutAnimation(opposite, null);
      board.setTargetDirectionIndicator(null);
      board.clearPlayerSideItems(primary);
      board.setPlayerSideOverlay(primary, null);
      for (const player of players.getAlivePlayerStats()) player.setPlayerSelectionHighlight(false);
      if (selected.length === 0) {
        items.refreshItemCommandSelection();
        items.clearItemActionControl();
        if (items.items.length < MAX_ITEM_SLOTS) items.appendItemSlot(new ItemSlot(0, 0, 0, false));
      } else {
        items.renderItemCommandSelection(selected[0]!.slotIndex);
        items.clearItemActionControl();
        items.resetItemArrangement(0);
      }
    }
    const itemIds = selected.length !== 0 ? selected.map(item => item.slotIndex) : [];
    selected.length = 0;
    let mp: number | undefined;
    let cp: number | undefined;
    let targetPlayerId: number | undefined;
    if (!rules.isDefending) {
      const controls = rules.exchangeControls;
      if (controls !== null) {
        mp = controls.statDisplay.mp;
        cp = controls.statDisplay.cp;
        rules.setCommandTargetControl(null);
      }
      if (rules.targetPlayer !== null) {
        targetPlayerId = rules.targetPlayer.playerId;
        rules.targetPlayer = null;
      }
    }
    const command = createCommandPayload({itemIds, mp, cp, targetPlayerId});
    rules.isDefending = false;
    const room = application.dialog;
    if (!(room instanceof RoomController)) throw new Error('No active room');
    return await room.updateRoomState(roomAction.submitCommand, true, new Map([['command', command]]));
  };
}
