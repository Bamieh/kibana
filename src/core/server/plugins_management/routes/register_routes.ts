/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { IRouter } from '../../http';
import { registerGetPluginsRoute } from './get_plugins';
import { registerGetAllowedPluginSourcesRoute } from './get_allowed_sources'
import { PluginsManager } from '../plugins_manager'

interface RegisterRoutesConfigs {
  router: IRouter;
  pluginsManager: PluginsManager;
}

export const registerRoutes = ({ router, pluginsManager }: RegisterRoutesConfigs) => {
  registerGetPluginsRoute(router, { pluginsManager });
  registerGetAllowedPluginSourcesRoute(router, { pluginsManager });
};
