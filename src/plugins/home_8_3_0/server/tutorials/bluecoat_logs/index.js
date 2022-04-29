/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

Object.defineProperty(exports, '__esModule', {
  value: true,
});
exports.bluecoatLogsSpecProvider = bluecoatLogsSpecProvider;

const _i18n = require('@kbn/i18n');

const _tutorials = require('../../services/tutorials');

const _filebeat_instructions = require('../instructions/filebeat_instructions');

function bluecoatLogsSpecProvider(context) {
  const moduleName = 'bluecoat';
  const platforms = ['OSX', 'DEB', 'RPM', 'WINDOWS'];
  return {
    id: 'bluecoatLogs',
    name: _i18n.i18n.translate('home.tutorials.bluecoatLogs.nameTitle', {
      defaultMessage: 'Bluecoat Logs',
    }),
    moduleName,
    category: _tutorials.TutorialsCategory.SECURITY_SOLUTION,
    shortDescription: _i18n.i18n.translate('home.tutorials.bluecoatLogs.shortDescription', {
      defaultMessage: 'Collect and parse logs from Blue Coat Director with Filebeat.',
    }),
    longDescription: _i18n.i18n.translate('home.tutorials.bluecoatLogs.longDescription', {
      defaultMessage:
        'This is a module for receiving Blue Coat Director logs over Syslog or a file. \
[Learn more]({learnMoreLink}).',
      values: {
        learnMoreLink: '{config.docs.beats.filebeat}/filebeat-module-bluecoat.html',
      },
    }),
    euiIconType: 'logoLogging',
    artifacts: {
      dashboards: [],
      application: {
        path: '/app/security',
        label: _i18n.i18n.translate('home.tutorials.bluecoatLogs.artifacts.dashboards.linkLabel', {
          defaultMessage: 'Security App',
        }),
      },
      exportedFields: {
        documentationUrl: '{config.docs.beats.filebeat}/exported-fields-bluecoat.html',
      },
    },
    completionTimeMinutes: 10,
    onPrem: (0, _filebeat_instructions.onPremInstructions)(moduleName, platforms, context),
    elasticCloud: (0, _filebeat_instructions.cloudInstructions)(moduleName, platforms, context),
    onPremElasticCloud: (0, _filebeat_instructions.onPremCloudInstructions)(
      moduleName,
      platforms,
      context
    ),
    integrationBrowserCategories: ['network', 'security'],
  };
}
