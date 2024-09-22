/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { uniq } from 'lodash';
import { useQuery } from '@tanstack/react-query';
import { i18n } from '@kbn/i18n';
import { API_VERSIONS } from '../../common/constants';
import { useKibana } from '../common/lib/kibana';
import { useErrorToast } from '../common/hooks/use_error_toast';

export const useOsqueryPolicies = () => {
  const { http } = useKibana().services;
  const setErrorToast = useErrorToast();

  return useQuery(
    ['osqueryPolicies'],
    () =>
      http.get<{ items: Array<{ policy_id: string; policy_ids: string[] }> }>(
        '/internal/osquery/fleet_wrapper/package_policies',
        { version: API_VERSIONS.internal.v1 }
      ),
    {
      select: (response) => uniq<string>(response.items.flatMap((p) => p.policy_ids)),
      onSuccess: () => setErrorToast(),
      onError: (error: Error) =>
        setErrorToast(error, {
          title: i18n.translate('xpack.osquery.osquery_policies.fetchError', {
            defaultMessage: 'Error while fetching osquery policies',
          }),
        }),
    }
  );
};
