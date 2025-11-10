/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import pLimit from 'p-limit';
import {
  type DataStreamDefinition,
  type IDataStreamClient,
  DataStreamClient,
} from '@kbn/data-streams';
import type { InternalElasticsearchServiceStart } from '@kbn/core-elasticsearch-server-internal';
import type { Logger } from '@kbn/logging';
import type { CoreContext, CoreService } from '@kbn/core-base-server-internal';
import type { DataStreamsSetup, DataStreamsStart } from '@kbn/core-data-streams-server';

interface StartDeps {
  elasticsearch: InternalElasticsearchServiceStart;
}

/** @internal */
export class DataStreamsService implements CoreService<DataStreamsSetup, DataStreamsStart> {
  private readonly logger: Logger;
  private readonly dataStreamDefinitions: Map<string, DataStreamDefinition<any, any>> = new Map();

  private readonly dataStreamClients: Map<string, IDataStreamClient<any, any>> = new Map();

  constructor(private readonly coreContext: CoreContext) {
    this.logger = this.coreContext.logger.get('data-streams');
  }

  setup() {
    return {
      registerDataStream: (dataStreamDefinition: DataStreamDefinition) => {
        if (!dataStreamDefinition.name) {
          throw new Error('Data stream name is required');
        }

        this.dataStreamDefinitions.set(dataStreamDefinition.name, dataStreamDefinition);
      },
    };
  }

  async start({ elasticsearch }: StartDeps) {
    const limit = pLimit(5);
    const setupPromises: Promise<void>[] = [];

    for (const [name, dataStreamDefinition] of this.dataStreamDefinitions.entries()) {
      if (!dataStreamDefinition) {
        throw new Error(`Data stream definition for ${name} is not registered.`);
      }

      setupPromises.push(
        limit(async () => {
          this.dataStreamClients.set(
            name,
            await DataStreamClient.initialize({
              dataStreams: dataStreamDefinition,
              elasticsearchClient: elasticsearch.client.asInternalUser,
              logger: this.logger,
            })
          );
        })
      );
    }

    await Promise.all(setupPromises);

    return {
      getClient: <S extends {}, SRM extends {}>(
        dataStreamName: string
      ): IDataStreamClient<S, SRM> => {
        const dataStreamDefinition = this.dataStreamDefinitions.get(dataStreamName);
        if (!dataStreamDefinition) {
          throw new Error(`Data stream ${dataStreamName} is not registered.`);
        }
        const client = this.dataStreamClients.get(dataStreamName);
        if (!client) {
          throw new Error(
            `Data stream client for ${dataStreamDefinition.name} is not initialized yet.`
          );
        }
        return client;
      },
    };
  }

  stop() {}
}
