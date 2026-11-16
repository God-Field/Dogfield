/**
 * Node entry point for live-game orchestration.
 *
 * It re-exports the real headless engine plus the pure wire-name catalog so the
 * scripts under tools/live-games never duplicate game rules or protocol names.
 */
export * from '../../src/engine';
export * from '../../src/services/protocol';
