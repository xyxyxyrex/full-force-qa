import type { FeedbackSubmission } from '../shared/types'

const kinds = new Set(['bug', 'feature', 'general'])
const areas = new Set(['dashboard', 'edit', 'live', 'audit', 'automate', 'notes', 'settings', 'other'])

export function validateFeedback(value: unknown): FeedbackSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Enter feedback before submitting.')
  const input = value as Record<string, unknown>
  if (typeof input.kind !== 'string' || !kinds.has(input.kind)) throw new Error('Choose a feedback type.')
  if (typeof input.area !== 'string' || !areas.has(input.area)) throw new Error('Choose where this happened.')
  if (typeof input.title !== 'string' || typeof input.details !== 'string') throw new Error('Enter a title and description.')
  const title = input.title.trim()
  const details = input.details.trim()
  if (title.length < 4 || title.length > 120) throw new Error('Use a title between 4 and 120 characters.')
  if (details.length < 10 || details.length > 4000) throw new Error('Use a description between 10 and 4,000 characters.')
  return { kind: input.kind as FeedbackSubmission['kind'], area: input.area as FeedbackSubmission['area'], title, details }
}
