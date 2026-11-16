import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageSelectionMenu } from '../src/ui/home-controls.ts';
import { state } from '../src/app/state.ts';
import { firestoreDocument } from '../src/services/protocol.ts';

test('the menu tracks user counts until it is disposed', () => {
  const listeners = [];
  const originalWindow = globalThis.window;
  const originalTranslations = state.translations;
  let unsubscribeCount = 0;
  globalThis.window = {
    firebase: {
      doc: (_database, path) => path,
      onSnapshot: (path, callback) => {
        listeners.push({ path, callback });
        return () => {
          unsubscribeCount++;
        };
      },
    },
  };
  state.database = {};
  state.translations = {
    getMenuText: key => (key === 'userCount' ? '{{count}} prophets' : ''),
  };

  try {
    const modeCards = ['training', 'private', 'duel'].map(key => ({
      mode: { key },
      descriptionWidget: { domElement: { textContent: '' } },
    }));
    const menu = new LanguageSelectionMenu(modeCards, {
      getAnimations: () => [],
      remove: () => {},
    });

    menu.renderUserCount();

    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].path, firestoreDocument.userCount);

    for (const [index, count] of [3, 5, 2].entries()) {
      listeners[0].callback({
        data: () => ({ training: count, private: 7, duel: 1 }),
      });
      assert.equal(
        modeCards[index].descriptionWidget.domElement.textContent,
        `${count} prophets`,
      );
    }
    assert.equal(modeCards[1].descriptionWidget.domElement.textContent, '7 prophets');
    assert.equal(modeCards[2].descriptionWidget.domElement.textContent, '1 prophets');

    menu.dispose();
    assert.equal(unsubscribeCount, 1);
  } finally {
    globalThis.window = originalWindow;
    state.translations = originalTranslations;
  }
});
