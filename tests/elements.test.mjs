import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnimatedElement, AnimationCancelledError, GameElement, TextElement } from '../src/ui/elements.ts';

test('text elements default to center and preserve alignment when text changes', () => {
  const element = {style: {textAlign: ''}, textContent: ''};
  const label = new TextElement(element);

  label.setText('Initial');
  assert.equal(element.style.textAlign, 'center');

  element.style.textAlign = 'right';
  label.setText('Updated');
  assert.equal(element.textContent, 'Updated');
  assert.equal(element.style.textAlign, 'right');
});

test('text elements preserve alignment already set during construction', () => {
  const element = {style: {textAlign: 'left'}, textContent: ''};
  const label = new TextElement(element);

  label.setText('Updated');

  assert.equal(element.style.textAlign, 'left');
});

test('named element bounds update only the provided dimensions', () => {
  const element = Object.create(GameElement.prototype);
  element.domElement = {style: {left: '12px', top: '18px', width: '90px', height: '45px'}};

  element.setElementBounds({top: 24, width: 120});

  assert.deepEqual(element.domElement.style, {
    left: '12px',
    top: '24px',
    width: '120px',
    height: '45px',
  });
});

test('position animation accepts named horizontal and vertical targets', async () => {
  const animated = Object.create(AnimatedElement.prototype);
  let movement;
  animated.translateElement = async (duration, easing, left, top) => {
    movement = {duration, easing, left, top};
    return null;
  };

  await animated.animateToPosition({left: 80}, 250, null);

  assert.deepEqual(movement, {duration: 250, easing: null, left: 80, top: null});
});

test('animated elements convert AbortError into AnimationCancelledError', async () => {
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  const animated = Object.create(AnimatedElement.prototype);
  animated.domElement = {
    animate() {
      return { finished: Promise.reject(abortError) };
    },
  };

  await assert.rejects(
    () => animated.animateElement([], 1, null),
    (error) =>
      error instanceof AnimationCancelledError
      && error.message.includes('aborted'),
  );
});

test('animated elements preserve unrelated animation failures', async () => {
  const failure = new Error('animation failed');
  const animated = Object.create(AnimatedElement.prototype);
  animated.domElement = {
    animate() {
      return { finished: Promise.reject(failure) };
    },
  };

  await assert.rejects(
    () => animated.animateElement([], 1, null),
    (error) => error === failure,
  );
});
