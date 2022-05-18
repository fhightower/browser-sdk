import type { Context } from '../../tools/context'
import { display } from '../../tools/display'
import { toStackTraceString } from '../../tools/error'
import { assign, combine, jsonStringify, performDraw, includes, startsWith } from '../../tools/utils'
import type { Configuration } from '../configuration'
import type { StackTrace } from '../tracekit'
import { computeStackTrace } from '../tracekit'
import { Observable } from '../../tools/observable'
import { timeStampNow } from '../../tools/timeUtils'
import { isExperimentalFeatureEnabled, INTAKE_SITE_STAGING, INTAKE_SITE_US5, INTAKE_SITE_US3 } from '../configuration'
import type { TelemetryEvent } from './telemetryEvent.types'

// replaced at build time
declare const __BUILD_ENV__SDK_VERSION__: string

const enum StatusType {
  debug = 'debug',
  error = 'error',
}

const ALLOWED_FRAME_URLS = [
  'https://www.datadoghq-browser-agent.com',
  'https://www.datad0g-browser-agent.com',
  'http://localhost',
  '<anonymous>',
]

export interface InternalMonitoring {
  setExternalContextProvider: (provider: () => Context) => void
  monitoringMessageObservable: Observable<MonitoringMessage>

  setTelemetryContextProvider: (provider: () => Context) => void
  telemetryEventObservable: Observable<TelemetryEvent & Context>
}

export interface MonitoringMessage extends Context {
  message: string
  status: StatusType
  error?: {
    kind?: string
    stack: string
  }
}

const TELEMETRY_ALLOWED_SITES: string[] = [
  INTAKE_SITE_US5,
  INTAKE_SITE_US3,
  // INTAKE_SITE_EU,
  // INTAKE_SITE_US,
]

const monitoringConfiguration: {
  debugMode?: boolean
  maxMessagesPerPage: number
  sentMessageCount: number
  telemetryEnabled: boolean
} = { maxMessagesPerPage: 0, sentMessageCount: 0, telemetryEnabled: false }

let onInternalMonitoringMessageCollected: ((message: MonitoringMessage) => void) | undefined

export function startInternalMonitoring(configuration: Configuration): InternalMonitoring {
  let externalContextProvider: () => Context
  let telemetryContextProvider: () => Context
  const monitoringMessageObservable = new Observable<MonitoringMessage>()
  const telemetryEventObservable = new Observable<TelemetryEvent & Context>()

  monitoringConfiguration.telemetryEnabled = performDraw(configuration.telemetrySampleRate)

  onInternalMonitoringMessageCollected = (message: MonitoringMessage) => {
    monitoringMessageObservable.notify(withContext(message))
    if (
      (isExperimentalFeatureEnabled('telemetry') || includes(TELEMETRY_ALLOWED_SITES, configuration.site)) &&
      monitoringConfiguration.telemetryEnabled
    ) {
      telemetryEventObservable.notify(toTelemetryEvent(message))
    }
  }

  assign(monitoringConfiguration, {
    maxMessagesPerPage: configuration.maxInternalMonitoringMessagesPerPage,
    sentMessageCount: 0,
  })

  function withContext(message: MonitoringMessage) {
    return combine(
      { date: timeStampNow() },
      externalContextProvider !== undefined ? externalContextProvider() : {},
      message
    )
  }

  function toTelemetryEvent(message: MonitoringMessage): TelemetryEvent & Context {
    return combine(
      {
        type: 'telemetry' as const,
        date: timeStampNow(),
        service: 'browser-sdk',
        version: __BUILD_ENV__SDK_VERSION__,
        source: 'browser' as const,
        _dd: {
          format_version: 2 as const,
        },
        telemetry: message as any, // https://github.com/microsoft/TypeScript/issues/48457
      },
      telemetryContextProvider !== undefined ? telemetryContextProvider() : {}
    )
  }

  return {
    setExternalContextProvider: (provider: () => Context) => {
      externalContextProvider = provider
    },
    monitoringMessageObservable,
    setTelemetryContextProvider: (provider: () => Context) => {
      telemetryContextProvider = provider
    },
    telemetryEventObservable,
  }
}

export function startFakeInternalMonitoring() {
  const messages: MonitoringMessage[] = []
  assign(monitoringConfiguration, {
    maxMessagesPerPage: Infinity,
    sentMessageCount: 0,
  })

  onInternalMonitoringMessageCollected = (message: MonitoringMessage) => {
    messages.push(message)
  }

  return messages
}

export function resetInternalMonitoring() {
  onInternalMonitoringMessageCollected = undefined
  monitoringConfiguration.debugMode = undefined
}

/**
 * Avoid mixing telemetry events from different data centers
 * but keep replicating staging events for reliability
 */
export function isTelemetryReplicationAllowed(configuration: Configuration) {
  return configuration.site === INTAKE_SITE_STAGING
}

export function monitored<T extends (...params: any[]) => unknown>(
  _: any,
  __: string,
  descriptor: TypedPropertyDescriptor<T>
) {
  const originalMethod = descriptor.value!
  descriptor.value = function (this: any, ...args: Parameters<T>) {
    const decorated = onInternalMonitoringMessageCollected ? monitor(originalMethod) : originalMethod
    return decorated.apply(this, args) as ReturnType<T>
  } as T
}

export function monitor<T extends (...args: any[]) => any>(fn: T): T {
  return function (this: any) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return callMonitored(fn, this, arguments as unknown as Parameters<T>)
  } as unknown as T // consider output type has input type
}

export function callMonitored<T extends (...args: any[]) => any>(
  fn: T,
  context: ThisParameterType<T>,
  args: Parameters<T>
): ReturnType<T> | undefined
export function callMonitored<T extends (this: void) => any>(fn: T): ReturnType<T> | undefined
export function callMonitored<T extends (...args: any[]) => any>(
  fn: T,
  context?: any,
  args?: any
): ReturnType<T> | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return fn.apply(context, args)
  } catch (e) {
    logErrorIfDebug(e)
    try {
      addMonitoringError(e)
    } catch (e) {
      logErrorIfDebug(e)
    }
  }
}

export function addMonitoringMessage(message: string, context?: Context) {
  logMessageIfDebug(message, context)
  addToMonitoring(
    assign(
      {
        message,
        status: StatusType.debug,
      },
      context
    )
  )
}

export function addMonitoringError(e: unknown) {
  addToMonitoring(
    assign(
      {
        status: StatusType.error,
      },
      formatError(e)
    )
  )
}

function addToMonitoring(message: MonitoringMessage) {
  if (
    onInternalMonitoringMessageCollected &&
    monitoringConfiguration.sentMessageCount < monitoringConfiguration.maxMessagesPerPage
  ) {
    monitoringConfiguration.sentMessageCount += 1
    onInternalMonitoringMessageCollected(message)
  }
}

function formatError(e: unknown) {
  if (e instanceof Error) {
    const stackTrace = computeStackTrace(e)
    return {
      error: {
        kind: stackTrace.name,
        stack: toStackTraceString(scrubCustomerFrames(stackTrace)),
      },
      message: stackTrace.message!,
    }
  }
  return {
    error: {
      stack: 'Not an instance of error',
    },
    message: `Uncaught ${jsonStringify(e)!}`,
  }
}

export function scrubCustomerFrames(stackTrace: StackTrace) {
  stackTrace.stack = stackTrace.stack.filter(
    (frame) => !frame.url || ALLOWED_FRAME_URLS.some((allowedFrameUrl) => startsWith(frame.url!, allowedFrameUrl))
  )
  return stackTrace
}

export function setDebugMode(debugMode: boolean) {
  monitoringConfiguration.debugMode = debugMode
}

function logErrorIfDebug(e: any) {
  if (monitoringConfiguration.debugMode) {
    display.error('[INTERNAL ERROR]', e)
  }
}

function logMessageIfDebug(message: any, context?: Context) {
  if (monitoringConfiguration.debugMode) {
    display.log('[MONITORING MESSAGE]', message, context)
  }
}
