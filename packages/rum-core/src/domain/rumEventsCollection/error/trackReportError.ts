import type { Observable, RawError } from '@datadog/browser-core'
import {
  clocksNow,
  ErrorHandling,
  ErrorSource,
  initReportObservable,
  CustomReportType,
  isExperimentalFeatureEnabled,
  noop,
} from '@datadog/browser-core'

export function trackReportError(errorObservable: Observable<RawError>) {
  if (!isExperimentalFeatureEnabled('forward-reports')) {
    return {
      stop: noop,
    }
  }

  const subscription = initReportObservable([CustomReportType.cspViolation, CustomReportType.intervention]).subscribe(
    (reportError) =>
      errorObservable.notify({
        startClocks: clocksNow(),
        message: reportError.message,
        stack: reportError.stack,
        type: reportError.type,
        source: ErrorSource.REPORT,
        handling: ErrorHandling.HANDLED,
      })
  )

  return {
    stop: () => {
      subscription.unsubscribe()
    },
  }
}