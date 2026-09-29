export interface MondayErrorDetails {
  message?: string
  code?: string
  status?: number
  retryAfterSeconds?: number
}

const FRIENDLY_MESSAGES = [
  /^Connect Monday\.com/i,
  /^Choose at least one Monday board/i,
  /^The selected Monday boards are no longer accessible/i,
  /^The Monday connection changed/i,
  /^Account changed during refresh/i,
  /^Enter a Monday personal API token/i,
  /^This Parity build does not include/i,
  /^Monday did not return the connected user/i,
  /^Monday OAuth (?:client ID|proxy)/i,
  /^Monday redirect URI/i,
  /^Port \d+ is currently busy/i,
  /^Login (?:timed out|was cancelled)/i,
  /^Monday denied access/i,
  /^This Monday account cannot use the API/i,
  /^Your Monday (?:admin restricts|connection is no longer valid)/i,
  /^A configured Monday board or item/i,
  /^This Monday (?:account has reached|feature is not available)/i,
  /^Monday(?:'s API complexity limit| is temporarily| is still processing| connection was cancelled| could not complete)/i,
  /^Monday (?:is limiting requests|temporarily blocked API requests)/i,
  /^Parity could not reach Monday/i,
  /^Monday rejected the refresh request/i,
]

function rawMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message || '')
  return ''
}

/** Removes Electron's IPC wrapper while preserving the provider error for classification. */
export function unwrapMondayErrorMessage(error: unknown): string {
  return rawMessage(error)
    .replace(/^Error invoking remote method ['"]monday:(?:graphql|status|login|set-personal-token)['"]:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

export function friendlyMondayError(error: unknown, details: MondayErrorDetails = {}): string {
  const message = (details.message || unwrapMondayErrorMessage(error)).trim()
  const code = String(details.code || '').trim()
  const status = Number(details.status || 0)
  const retry = Number(details.retryAfterSeconds || 0)
  const searchable = `${code} ${message}`.toLowerCase()
  const wait = retry > 0 ? ` Try again in about ${Math.ceil(retry)} seconds.` : ' Wait a moment, then refresh again.'

  if (FRIENDLY_MESSAGES.some(pattern => pattern.test(message))) return message

  if (/user_access_denied|account.*(?:inactive|disabled)|view[- ]only|unconfirmed (?:email|user)/i.test(searchable)) {
    return 'This Monday account cannot use the API. Confirm the account email and use an active member account.'
  }
  if (/user_unauthorized|userunauthorizedexception|user unauthorized|not (?:authorized|permitted)|missing.*permission|permission denied|forbidden/.test(searchable) || status === 403) {
    return 'Monday denied access to a configured board or workspace. Ask a Monday admin to grant access, or reconnect with an account that can view it.'
  }
  if (/ip.*restrict|ip_rate_limit_exceeded/.test(searchable)) {
    return /rate/.test(searchable)
      ? `Monday is limiting requests from this network.${wait}`
      : 'Your Monday admin restricts API access from this network. Use an approved network or ask an admin to allow your IP address.'
  }
  if (/unauthorized|invalid.*(?:token|api key)|expired.*token|authentication|not authenticated/.test(searchable) || status === 401) {
    return 'Your Monday connection is no longer valid. Reconnect Monday in Integrations, then try again.'
  }
  if (/resource.?not.?found|not_found|requested resource.*not found|invalid.*(?:board|item).*id/.test(searchable) || status === 404) {
    return 'A configured Monday board or item no longer exists or is not accessible. Review the selected boards in Integrations.'
  }
  if (/daily_limit_exceeded|daily.*limit|daily.*budget/.test(searchable)) {
    return 'This Monday account has reached its daily API limit. Try again after the limit resets or ask a Monday admin to review the account plan.'
  }
  if (/complexity(?:exception|_budget_exhausted)|complexity.*(?:limit|budget)/.test(searchable)) {
    return `Monday's API complexity limit was reached.${wait}`
  }
  if (/maxconcurrencyexceeded|rate limit|rate_limit|too many requests/.test(searchable) || status === 429) {
    return `Monday is temporarily limiting requests.${wait}`
  }
  if (/api_temporarily_blocked|temporarily blocked/.test(searchable)) {
    return `Monday temporarily blocked API requests for this account.${wait}`
  }
  if (/resource.*locked|locked resource/.test(searchable) || status === 423) {
    return `Monday is still processing this resource.${wait}`
  }
  if (/feature.*(?:not enabled|unavailable)|unsupported.*feature/.test(searchable)) {
    return 'This Monday feature is not available for the connected account or plan. Review the account permissions and plan.'
  }
  if (/failed to fetch|network|econn|enotfound|socket|timed? ?out|timeout/.test(searchable)) {
    return 'Parity could not reach Monday. Check your internet connection and try again.'
  }
  if (/bad request|jsonparse|columnvalueexception|validation|parse error/.test(searchable) || status === 400) {
    return 'Monday rejected the refresh request. Review the integration settings and try again.'
  }
  if (status >= 500 || /internal server|service unavailable|gateway error/.test(searchable)) {
    return 'Monday is temporarily unavailable. Try again later.'
  }
  if (/access_denied|authorization.*(?:declined|cancelled|canceled)/.test(searchable)) {
    return 'Monday connection was cancelled. Try connecting again when you are ready.'
  }

  return 'Monday could not complete this request. Check the connection and selected boards in Integrations, then try again.'
}
