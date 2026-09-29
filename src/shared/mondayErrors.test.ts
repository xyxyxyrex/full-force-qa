import { describe, expect, it } from 'vitest'
import { friendlyMondayError, unwrapMondayErrorMessage } from './mondayErrors'

describe('friendlyMondayError', () => {
  it('unwraps Electron errors and explains missing resource permission', () => {
    const raw = "Error invoking remote method 'monday:graphql': Error: User unauthorized to perform action"
    expect(unwrapMondayErrorMessage(raw)).toBe('User unauthorized to perform action')
    const friendly = friendlyMondayError(raw)
    expect(friendly).toContain('denied access to a configured board or workspace')
    expect(friendlyMondayError(`Error invoking remote method 'monday:graphql': Error: ${friendly}`)).toBe(friendly)
  })

  it.each([
    [{ code: 'USER_ACCESS_DENIED' }, 'cannot use the API'],
    [{ status: 401 }, 'connection is no longer valid'],
    [{ message: 'Your ip is restricted' }, 'restricts API access from this network'],
    [{ code: 'ResourceNotFoundException' }, 'no longer exists or is not accessible'],
    [{ code: 'DAILY_LIMIT_EXCEEDED' }, 'daily API limit'],
    [{ code: 'COMPLEXITY_BUDGET_EXHAUSTED', retryAfterSeconds: 12 }, 'about 12 seconds'],
    [{ code: 'maxConcurrencyExceeded', retryAfterSeconds: 4 }, 'temporarily limiting requests'],
    [{ status: 500 }, 'temporarily unavailable'],
  ])('maps Monday account/API details %#', (details, expected) => {
    expect(friendlyMondayError('', details)).toContain(expected)
  })

  it('does not expose unknown technical messages', () => {
    expect(friendlyMondayError('GraphQL exploded at resolver Foo.bar')).not.toContain('resolver')
  })
})
