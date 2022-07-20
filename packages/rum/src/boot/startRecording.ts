import { createHttpRequest, timeStampNow } from '@datadog/browser-core'
import type {
  LifeCycle,
  ViewContexts,
  RumConfiguration,
  RumSessionManager,
  ViewCreatedEvent,
} from '@datadog/browser-rum-core'
import { LifeCycleEventType } from '@datadog/browser-rum-core'

import { record } from '../domain/record'
import type { DeflateWorker } from '../domain/segmentCollection'
import { SEGMENT_BYTES_LIMIT, startSegmentCollection } from '../domain/segmentCollection'
import { send } from '../transport/send'
import { RecordType } from '../types'

export function startRecording(
  lifeCycle: LifeCycle,
  configuration: RumConfiguration,
  sessionManager: RumSessionManager,
  viewContexts: ViewContexts,
  worker: DeflateWorker,
  httpRequest = createHttpRequest(configuration.sessionReplayEndpointBuilder, SEGMENT_BYTES_LIMIT)
) {
  const { addRecord, stop: stopSegmentCollection } = startSegmentCollection(
    lifeCycle,
    configuration.applicationId,
    sessionManager,
    viewContexts,
    (data, metadata, rawSegmentBytesCount) => send(httpRequest, data, metadata, rawSegmentBytesCount),
    worker
  )

  const {
    stop: stopRecording,
    takeFullSnapshot,
    flushMutations,
  } = record({
    emit: addRecord,
    defaultPrivacyLevel: configuration.defaultPrivacyLevel,
  })

  const { unsubscribe: unsubscribeViewEnded } = lifeCycle.subscribe(LifeCycleEventType.VIEW_ENDED, () => {
    flushMutations()
    addRecord({
      timestamp: timeStampNow(),
      type: RecordType.ViewEnd,
    })
  })
  const { unsubscribe: unsubscribeViewCreated } = lifeCycle.subscribe(
    LifeCycleEventType.VIEW_CREATED,
    (view: ViewCreatedEvent) => {
      takeFullSnapshot(view.startClocks.timeStamp)
    }
  )

  return {
    stop: () => {
      unsubscribeViewEnded()
      unsubscribeViewCreated()
      stopRecording()
      stopSegmentCollection()
    },
  }
}
