/**
 * Registers a DOM implementation so component tests can render React.
 *
 * Wired in via `bunfig.toml` -> [test] preload. Pure-logic tests are unaffected.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
