import '../../src/main';
import { getApplication } from '../../src/app/runtime';
import { submitItemActionCommand } from '../../src/battle/submit-command';
import { TurnController } from '../../src/battle/turn-controller';
const errors: string[] = [];
const dispatch = TurnController.prototype.dispatchTurnAction;
TurnController.prototype.dispatchTurnAction = async function (event) {
  try {
    return await dispatch.call(this, event);
  } catch (error) {
    errors.push(`${event.action}: ${error instanceof Error ? error.stack : error}`);
    throw error;
  }
};
Object.assign(window, {
  localServerTest: {
    getApplication,
    errors,
    submitItemActionCommand,
  },
});
