/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom';
import { Router, Switch, Route } from 'react-router-dom';
import { I18nProvider } from '@kbn/i18n-react';
import { i18n } from '@kbn/i18n';
import { EuiLoadingSpinner } from '@elastic/eui';
import { CoreSetup } from '@kbn/core/public';
import { wrapWithTheme } from '@kbn/kibana-react-plugin/public';
import { ManagementAppMountParams } from '@kbn/management-plugin/public';
import type { AllowedPluginSource } from '../../common/types';
import { StartDependencies, SavedObjectsManagementPluginStart } from '../plugin';
import { getAllowedPluginSources } from '../lib';

interface MountParams {
  core: CoreSetup<StartDependencies, SavedObjectsManagementPluginStart>;
  mountParams: ManagementAppMountParams;
}

let allowedPluginSources: AllowedPluginSource[] | undefined;

const title = i18n.translate('savedObjectsManagement.objects.savedObjectsTitle', {
  defaultMessage: 'Plugins Management',
});

const SavedObjectsEditionPage = lazy(() => import('./saved_objects_edition_page'));
const PluginsTablePage = lazy(() => import('./plugins_table_page'));

export const mountManagementSection = async ({ core, mountParams }: MountParams) => {
  const [coreStart, { data, dataViews, savedObjectsTaggingOss }, pluginStart] =
    await core.getStartServices();
  const { capabilities } = coreStart.application;
  const { element, history, setBreadcrumbs } = mountParams;
  const { theme$ } = core.theme;

  if (!allowedPluginSources) {
    allowedPluginSources = await getAllowedPluginSources(coreStart.http);
  }

  coreStart.chrome.docTitle.change(title);

  const RedirectToHomeIfUnauthorized: React.FunctionComponent = ({ children }) => {
    const allowed = capabilities?.management?.kibana?.objects ?? false;

    if (!allowed) {
      coreStart.application.navigateToApp('home');
      
      return null;
    }
    return children! as React.ReactElement;
  };

  ReactDOM.render(
    wrapWithTheme(
      <I18nProvider>
        <Router history={history}>
          <Switch>
            <Route path={'/:id'} exact={true}>
              <RedirectToHomeIfUnauthorized>
                <Suspense fallback={<EuiLoadingSpinner />}>
                  <SavedObjectsEditionPage
                    coreStart={coreStart}
                    setBreadcrumbs={setBreadcrumbs}
                    history={history}
                  />
                </Suspense>
              </RedirectToHomeIfUnauthorized>
            </Route>
            <Route path={'/'} exact={false}>
              <RedirectToHomeIfUnauthorized>
                <Suspense fallback={<EuiLoadingSpinner />}>
                  <PluginsTablePage
                    coreStart={coreStart}
                    taggingApi={savedObjectsTaggingOss?.getTaggingApi()}
                    dataStart={data}
                    dataViewsApi={dataViews}
                    actionRegistry={pluginStart.actions}
                    columnRegistry={pluginStart.columns}
                    allowedSources={allowedPluginSources}
                    setBreadcrumbs={setBreadcrumbs}
                  />
                </Suspense>
              </RedirectToHomeIfUnauthorized>
            </Route>
          </Switch>
        </Router>
      </I18nProvider>,
      theme$
    ),
    element
  );

  return () => {
    coreStart.chrome.docTitle.reset();
    ReactDOM.unmountComponentAtNode(element);
  };
};
