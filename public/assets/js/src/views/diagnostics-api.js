import { bag } from '../bag.js';

/** @deprecated Aliases → viewTests (#settings/tests). Kept so old imports keep installing. */
export function install() {
  if (typeof bag.viewTests === 'function') {
    bag.viewDiagnosticsApi = bag.viewTests;
  }
}
