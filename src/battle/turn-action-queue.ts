import {appendAll, removeAt} from '../shared/collections';

export class TurnActionQueue<Action> {
  isProcessing = false;

  constructor(
    public pendingActions: Action[],
    private readonly hideCommandOverlay: () => void,
    private readonly dispatchAction: (action: Action) => Promise<unknown>,
    private readonly renderCurrentCommand: () => void,
    private readonly isGameOver: () => boolean,
  ) {}

  async enqueue(actions: Action[]): Promise<unknown> {
    try {
      this.hideCommandOverlay();
      appendAll(this.pendingActions, actions);
      if (this.isProcessing) {
        return null;
      }

      this.isProcessing = true;
      let result: unknown = null;
      while (this.pendingActions.length !== 0) {
        result = await this.dispatchAction(removeAt(this.pendingActions, 0));
      }
      this.isProcessing = false;

      if (!this.isGameOver()) {
        this.renderCurrentCommand();
      }
      return result;
    } catch (error) {
      // Preserve the existing client behavior: queue failures resolve and leave
      // processing set so later snapshots do not replay a partially failed turn.
      return error;
    }
  }
}
