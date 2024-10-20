/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
export * from '../../../../entity_analytics/components/risk_score/translations';

export const FEED_NAME_PREPOSITION = i18n.translate(
  'xpack.securitySolution.eventDetails.ctiSummary.feedNamePreposition',
  {
    defaultMessage: 'from',
  }
);

export const INDICATOR_ENRICHMENT_TITLE = i18n.translate(
  'xpack.securitySolution.eventDetails.ctiSummary.indicatorEnrichmentTitle',
  {
    defaultMessage: 'Threat match detected',
  }
);

export const INVESTIGATION_ENRICHMENT_TITLE = i18n.translate(
  'xpack.securitySolution.eventDetails.ctiSummary.investigationEnrichmentTitle',
  {
    defaultMessage: 'Enriched with threat intelligence',
  }
);

export const INDICATOR_TOOLTIP_CONTENT = i18n.translate(
  'xpack.securitySolution.eventDetails.ctiSummary.indicatorEnrichmentTooltipContent',
  {
    defaultMessage: 'Shows available threat indicator matches.',
  }
);

export const INVESTIGATION_TOOLTIP_CONTENT = i18n.translate(
  'xpack.securitySolution.eventDetails.ctiSummary.investigationEnrichmentTooltipContent',
  {
    defaultMessage:
      'Shows additional threat intelligence for the alert. The past 30 days were queried by default.',
  }
);

export const NO_ENRICHMENTS_FOUND_DESCRIPTION = i18n.translate(
  'xpack.securitySolution.alertDetails.noEnrichmentsFoundDescription',
  {
    defaultMessage: 'This alert does not have threat intelligence.',
  }
);

export const INVESTIGATION_QUERY_TITLE = i18n.translate(
  'xpack.securitySolution.alertDetails.investigationTimeQueryTitle',
  {
    defaultMessage: 'Enrichment with Threat Intelligence',
  }
);

export const ENRICHMENT_LOOKBACK_START_DATE = i18n.translate(
  'xpack.securitySolution.alertDetails.enrichmentQueryStartDate',
  {
    defaultMessage: 'Start date',
  }
);

export const ENRICHMENT_LOOKBACK_END_DATE = i18n.translate(
  'xpack.securitySolution.alertDetails.enrichmentQueryEndDate',
  {
    defaultMessage: 'End date',
  }
);

export const REFRESH = i18n.translate('xpack.securitySolution.alertDetails.refresh', {
  defaultMessage: 'Refresh',
});

export const NESTED_OBJECT_VALUES_NOT_RENDERED = i18n.translate(
  'xpack.securitySolution.eventDetails.ctiSummary.investigationEnrichmentObjectValuesNotRendered',
  {
    defaultMessage:
      'This field contains nested object values, which are not rendered here. See the full document for all fields/values',
  }
);
