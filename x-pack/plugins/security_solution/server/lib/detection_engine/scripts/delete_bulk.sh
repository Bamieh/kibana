#!/bin/sh

#
# Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
# or more contributor license agreements. Licensed under the Elastic License;
# you may not use this file except in compliance with the Elastic License.
#

set -e
./check_env_variables.sh

# Uses a default if no argument is specified
RULES=${1:-./rules/bulk/delete_by_rule_id.json}

# Example: ./delete_rule_bulk.sh
curl -s -k \
  -H 'Content-Type: application/json' \
  -H 'kbn-xsrf: 123' \
  -u ${ELASTICSEARCH_USERNAME}:${ELASTICSEARCH_PASSWORD} \
  -X DELETE ${KIBANA_URL}${SPACE_URL}/api/detection_engine/rules/_bulk_delete \
  -d @${RULES} \
  | jq .;
