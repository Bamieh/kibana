import { DataStreamDefinition, DataStreamsSetup } from "@kbn/core/packages/data-streams/server";
import { WORKFLOWS_EXECUTION_LOGS_DATA_STREAM } from "../../../common";
import { mappings } from '@kbn/core-data-streams-server';


export const getDataStreamDefinition = (): DataStreamDefinition => {
  return {
    name: WORKFLOWS_EXECUTION_LOGS_DATA_STREAM,
    version: 1,
    template: {},
  }
}

export const initializeLogsRepositoryDataStream = (coreDataStreams: DataStreamsSetup) => {
  return coreDataStreams.registerDataStream({
    ...getDataStreamDefinition(),
    template: {
      mappings: {
        dynamic: false,
        properties: {
          '@timestamp': mappings.date(),
          spaceId: mappings.keyword(),
          message: mappings.text(),
          level: mappings.keyword(),
          tags: mappings.keyword(),
          workflow: mappings.object({
            id: mappings.keyword(),
            name: mappings.text({
              fields: {
                keyword: {
                  type: 'keyword',
                  ignore_above: 256,
                },
              },
            }),
            execution_id: mappings.keyword(),
            step_id: mappings.keyword(),
            step_name: mappings.text({
              fields: {
                keyword: {
                  type: 'keyword',
                  ignore_above: 256,
                },
              },
            }),
            step_type: mappings.keyword(),
          }),
          event: mappings.object({
            action: mappings.keyword(),
            category: mappings.keyword(),
            type: mappings.keyword(),
            provider: mappings.keyword(),
            outcome: mappings.keyword(),
            duration: mappings.long(),
            start: mappings.date(),
            end: mappings.date(),
          }),
          error: mappings.object({
            message: mappings.text(),
            type: mappings.keyword(),
            stack_trace: mappings.text({ fields: undefined }),
          }),          
        },
      },
    },
  });
}