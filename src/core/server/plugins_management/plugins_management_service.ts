/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { Logger } from '../logging';
import { IConfigService } from '../config';
import { CoreContext } from '../core_context';
import { InternalHttpServiceSetup } from '../http';
import { registerRoutes } from './routes';
import { PluginsManager } from './plugins_manager';
// import type { PluginsService } from '../plugins';

export interface SetupDeps {
  http: InternalHttpServiceSetup;
  // plugins: PluginsService;
}

/**
 * @public
 */
export interface PluginsManagementServiceSetup {}
export interface PluginsManagementServiceStart {}

export class PluginsManagementService {
  private readonly log: Logger;
  private readonly configService: IConfigService;
  private pluginsManager?: PluginsManager;

  constructor(coreContext: CoreContext) {
    this.log = coreContext.logger.get('Plugins Manager');
    this.configService = coreContext.configService;
  }

  public setup({ http }: SetupDeps): PluginsManagementServiceSetup {
    const router = http.createRouter('/api/plugins/');
    this.pluginsManager = new PluginsManager();
    this.pluginsManager
      .resetConsole()
      .then(() => {
        console.log('sucessfully reset console!');
      })
      .catch((e) => {
        console.log(`failed reset console ${e}`);
      });

    registerRoutes({
      router,
      pluginsManager: this.pluginsManager,
    });

    return {};
  }

  public start(): PluginsManagementServiceStart {
    return {};
  }

  public stop() {}
}
