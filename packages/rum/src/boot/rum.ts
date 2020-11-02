import { combine, commonInit, Configuration, Context } from '@datadog/browser-core'
import { startDOMMutationCollection } from '../browser/domMutationCollection'
import { startPerformanceCollection } from '../browser/performanceCollection'
import { startRumAssembly } from '../domain/assembly'
import { startRumAssemblyV2 } from '../domain/assemblyV2'
import { startInternalContext } from '../domain/internalContext'
import { LifeCycle, LifeCycleEventType } from '../domain/lifeCycle'
import { startParentContexts } from '../domain/parentContexts'
import { startRequestCollection } from '../domain/requestCollection'
import { startActionCollection } from '../domain/rumEventsCollection/action/actionCollection'
import { CustomAction } from '../domain/rumEventsCollection/action/trackActions'
import { ProvidedError, startErrorCollection } from '../domain/rumEventsCollection/error/errorCollection'
import { startLongTaskCollection } from '../domain/rumEventsCollection/longTask/longTaskCollection'
import { startResourceCollection } from '../domain/rumEventsCollection/resource/resourceCollection'
import { startViewCollection } from '../domain/rumEventsCollection/view/viewCollection'
import { RumSession, startRumSession } from '../domain/rumSession'
import { startRumBatch } from '../transport/batch'

import { buildEnv } from './buildEnv'
import { RumUserConfiguration } from './rum.entry'

export function startRum(userConfiguration: RumUserConfiguration, getGlobalContext: () => Context) {
  const lifeCycle = new LifeCycle()

  const isCollectingError = true
  const { errorObservable, configuration, internalMonitoring } = commonInit(
    userConfiguration,
    buildEnv,
    isCollectingError
  )
  const session = startRumSession(configuration, lifeCycle)

  internalMonitoring.setExternalContextProvider(() => {
    return combine(
      {
        application_id: userConfiguration.applicationId,
      },
      parentContexts.findView(),
      getGlobalContext()
    )
  })

  const { parentContexts } = startRumEventCollection(
    userConfiguration.applicationId,
    location,
    lifeCycle,
    configuration,
    session,
    getGlobalContext
  )

  startRequestCollection(lifeCycle, configuration)
  startPerformanceCollection(lifeCycle, configuration)
  startDOMMutationCollection(lifeCycle)

  const internalContext = startInternalContext(userConfiguration.applicationId, session, parentContexts, configuration)

  errorObservable.subscribe((errorMessage) => lifeCycle.notify(LifeCycleEventType.ERROR_COLLECTED, errorMessage))

  return {
    getInternalContext: internalContext.get,

    addAction(action: CustomAction, context?: Context) {
      lifeCycle.notify(LifeCycleEventType.CUSTOM_ACTION_COLLECTED, { action, context })
    },

    addError(error: ProvidedError, context?: Context) {
      lifeCycle.notify(LifeCycleEventType.ERROR_PROVIDED, { error, context })
    },
  }
}

export function startRumEventCollection(
  applicationId: string,
  location: Location,
  lifeCycle: LifeCycle,
  configuration: Configuration,
  session: RumSession,
  getGlobalContext: () => Context
) {
  const parentContexts = startParentContexts(lifeCycle, session)
  const batch = startRumBatch(configuration, lifeCycle)
  startRumAssembly(applicationId, configuration, lifeCycle, session, parentContexts, getGlobalContext)
  startRumAssemblyV2(applicationId, configuration, lifeCycle, session, parentContexts, getGlobalContext)
  startLongTaskCollection(lifeCycle, configuration)
  startResourceCollection(lifeCycle, configuration, session)
  startViewCollection(lifeCycle, configuration, location)
  startErrorCollection(lifeCycle, configuration)
  startActionCollection(lifeCycle, configuration)

  return {
    parentContexts,

    stop() {
      // prevent batch from previous tests to keep running and send unwanted requests
      // could be replaced by stopping all the component when they will all have a stop method
      batch.stop()
    },
  }
}