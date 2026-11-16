import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TurnActionQueue} from '../src/battle/turn-action-queue.ts';

test('turn action queue drains events added during playback in order', async () => {
  const actions = [];
  const dispatched = [];
  let releaseFirstAction;
  let isFirstActionBlocked = true;
  let renderCount = 0;
  const firstActionGate = new Promise(resolve => {
    releaseFirstAction = resolve;
  });
  const queue = new TurnActionQueue(
    actions,
    () => {},
    async action => {
      dispatched.push(action);
      if (action === 'first' && isFirstActionBlocked) {
        isFirstActionBlocked = false;
        await firstActionGate;
      }
      return action;
    },
    () => {
      renderCount += 1;
    },
    () => false,
  );

  const firstPlayback = queue.enqueue(['first']);
  await Promise.resolve();
  assert.equal(await queue.enqueue(['second']), null);
  releaseFirstAction();

  assert.equal(await firstPlayback, 'second');
  assert.deepEqual(dispatched, ['first', 'second']);
  assert.equal(renderCount, 1);
  assert.equal(queue.isProcessing, false);
});

test('turn action queue resolves handler errors and retains its failed state', async () => {
  const failure = new Error('event playback failed');
  const queue = new TurnActionQueue(
    [],
    () => {},
    async () => {
      throw failure;
    },
    () => {},
    () => false,
  );

  assert.equal(await queue.enqueue(['broken']), failure);
  assert.equal(queue.isProcessing, true);
});
