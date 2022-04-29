/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import './index.scss';
import { PluginInitializerContext } from '@kbn/core/public';

import { ConsoleUIPlugin } from './plugin';

console.log('yeah v2');

export type { ConsoleUILocatorParams, ConsolePluginSetup } from './types';

export { ConsoleUIPlugin as Plugin };

export function plugin(ctx: PluginInitializerContext) {
  return new ConsoleUIPlugin(ctx);
}
