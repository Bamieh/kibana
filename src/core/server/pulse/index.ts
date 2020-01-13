/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { readdirSync } from 'fs';
import { resolve, parse } from 'path';
import { Subject } from 'rxjs';
// @ts-ignore
import fetch from 'node-fetch';
import { CoreContext } from '../core_context';
import { Logger } from '../logging';
import { ElasticsearchServiceSetup, IClusterClient } from '../elasticsearch';
import { PulseChannel, PulseInstruction } from './channel';
import { sendPulse, Fetcher } from './send_pulse';
import { SavedObjectsServiceSetup } from '../saved_objects';

export interface InternalPulseService {
  getChannel: (id: string) => PulseChannel;
}

export interface PulseSetupDeps {
  elasticsearch: ElasticsearchServiceSetup;
  savedObjects: SavedObjectsServiceSetup;
}

export type PulseServiceSetup = InternalPulseService;

export interface ChannelResponse {
  id: string;
  instructions: PulseInstruction[];
}

export interface InstructionsResponse {
  channels: ChannelResponse[];
}

const channelNames = readdirSync(resolve(__dirname, 'collectors'))
  .filter((fileName: string) => !fileName.startsWith('.'))
  .map((fileName: string) => {
    // Get the base name without the extension
    return parse(fileName).name;
  });

export class PulseService {
  private retriableErrors = 0;
  private readonly log: Logger;
  private readonly channels: Map<string, PulseChannel>;
  private readonly instructions$: Map<string, Subject<any>> = new Map();
  private elasticsearch?: IClusterClient;

  constructor(coreContext: CoreContext) {
    this.log = coreContext.logger.get('pulse-service');
    this.channels = new Map(
      channelNames.map((id): [string, PulseChannel] => {
        const instructions$ = new Subject<PulseInstruction>();
        this.instructions$.set(id, instructions$);
        const channel = new PulseChannel({ id, instructions$, logger: this.log });
        return [channel.id, channel];
      })
    );
  }

  public async setup(deps: PulseSetupDeps): Promise<InternalPulseService> {
    this.log.debug('Setting up pulse service');

    this.elasticsearch = deps.elasticsearch.createClient('pulse-service');
    this.channels.forEach(ch =>
      ch.setup({
        elasticsearch: this.elasticsearch!,
        savedObjects: deps.savedObjects,
      })
    );

    // poll for instructions every second for this deployment
    setInterval(() => {
      this.loadInstructions().catch(err => this.log.error(err.stack));
    }, 10000);

    this.log.debug('Will attempt first telemetry collection in 5 seconds...');
    setTimeout(() => {
      setInterval(() => {
        this.sendTelemetry().catch(err => this.log.error(err.stack));
      }, 5000);
    }, 5000);

    return {
      getChannel: (id: string) => {
        const channel = this.channels.get(id);
        if (!channel) {
          throw new Error(`Unknown channel: ${id}`);
        }
        return channel;
      },
    };
  }

  private async loadInstructions() {
    const url = 'http://localhost:5601/api/pulse_poc/instructions/123';
    let response: any;
    try {
      response = await fetch(url);
    } catch (err) {
      if (!err.message.includes('ECONNREFUSED')) {
        throw err;
      }
      this.handleRetriableError();
      return;
    }
    if (response.status === 503) {
      this.handleRetriableError();
      return;
    }

    if (response.status !== 200) {
      const responseBody = await response.text();
      throw new Error(`${response.status}: ${responseBody}`);
    }

    const responseBody: InstructionsResponse = await response.json();

    responseBody.channels.forEach(channel => {
      const instructions$ = this.instructions$.get(channel.id);
      if (!instructions$) {
        throw new Error(
          `Channel (${channel.id}) from service has no corresponding channel handler in client`
        );
      }

      channel.instructions.forEach(instruction => instructions$.next(instruction));
    });
  }

  private handleRetriableError() {
    this.retriableErrors++;
    if (this.retriableErrors === 1) {
      this.log.warn(
        'Kibana is not yet available at http://localhost:5601/api, will continue to check for the next 120 seconds...'
      );
    } else if (this.retriableErrors > 120) {
      this.retriableErrors = 0;
    }
  }

  private async sendTelemetry() {
    const fetcher: Fetcher<any> = async (url, channels) => {
      return await fetch(url, {
        method: 'post',

        headers: {
          'content-type': 'application/json',
          'kbn-xsrf': 'true',
        },
        body: JSON.stringify({
          channels,
        }),
      });
    };

    return await sendPulse(this.channels, fetcher);
  }
}
