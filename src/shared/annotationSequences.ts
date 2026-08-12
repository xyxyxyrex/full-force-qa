import type { ProjectAnnotation, ProjectAnnotationSequence } from './types'

const orderOf = (annotation: ProjectAnnotation) =>
  Number.isFinite(annotation.sequenceOrder) ? Number(annotation.sequenceOrder) : Number.MAX_SAFE_INTEGER

export function annotationSequencePath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  minimumBend = 36,
): string {
  const direction = endX < startX ? -1 : 1
  const bend = Math.max(minimumBend, Math.abs(endX - startX) * 0.42)
  return `M ${startX} ${startY} C ${startX + direction * bend} ${startY}, ${endX - direction * bend} ${endY}, ${endX} ${endY}`
}

export function buildAnnotationSequences(
  annotations: readonly ProjectAnnotation[],
): ProjectAnnotationSequence[] {
  const ids = new Set(annotations.map((annotation) => annotation.id))
  const groups = new Map<string, ProjectAnnotation[]>()

  for (const annotation of annotations) {
    const parentId = annotation.sequenceParentId
    if (!parentId || !ids.has(parentId)) continue
    const group = groups.get(parentId) || []
    group.push(annotation)
    groups.set(parentId, group)
  }

  return Array.from(groups.entries())
    .map(([parentAnnotationId, members]) => ({
      parentAnnotationId,
      annotationIds: members
        .sort((a, b) => orderOf(a) - orderOf(b) || a.badgeNumber - b.badgeNumber)
        .map((annotation) => annotation.id),
    }))
    .filter((sequence) =>
      sequence.annotationIds.length > 1 && sequence.annotationIds[0] === sequence.parentAnnotationId,
    )
}

function clearSequence<T extends ProjectAnnotation>(annotation: T): T {
  const { sequenceParentId: _parent, sequenceOrder: _order, ...rest } = annotation
  return rest as T
}

function normalizeGroup<T extends ProjectAnnotation>(
  annotations: readonly T[],
  orderedIds: readonly string[],
): T[] {
  if (orderedIds.length < 2) {
    const remainingId = orderedIds[0]
    return annotations.map((annotation) =>
      annotation.id === remainingId ? clearSequence(annotation) : annotation,
    )
  }

  const parentAnnotationId = orderedIds[0]
  const positions = new Map(orderedIds.map((id, index) => [id, index]))
  return annotations.map((annotation) => {
    const sequenceOrder = positions.get(annotation.id)
    return sequenceOrder === undefined
      ? annotation
      : { ...annotation, sequenceParentId: parentAnnotationId, sequenceOrder }
  })
}

export function unlinkAnnotation<T extends ProjectAnnotation>(
  annotations: readonly T[],
  annotationId: string,
): T[] {
  const target = annotations.find((annotation) => annotation.id === annotationId)
  if (!target?.sequenceParentId) return [...annotations]

  const sequence = buildAnnotationSequences(annotations).find(
    (candidate) => candidate.parentAnnotationId === target.sequenceParentId,
  )
  if (!sequence) {
    return annotations.map((annotation) =>
      annotation.id === annotationId ? clearSequence(annotation) : annotation,
    )
  }

  const remainingIds = sequence.annotationIds.filter((id) => id !== annotationId)
  let next = annotations.map((annotation) =>
    sequence.annotationIds.includes(annotation.id) ? clearSequence(annotation) : annotation,
  )
  next = normalizeGroup(next, remainingIds)
  return next
}

export function linkAnnotations<T extends ProjectAnnotation>(
  annotations: readonly T[],
  sourceId: string,
  targetId: string,
): T[] {
  if (!sourceId || !targetId || sourceId === targetId) return [...annotations]
  const source = annotations.find((annotation) => annotation.id === sourceId)
  const target = annotations.find((annotation) => annotation.id === targetId)
  if (!source || !target) return [...annotations]

  let next = unlinkAnnotation(annotations, targetId)
  const refreshedSource = next.find((annotation) => annotation.id === sourceId)!
  const sourceSequence = refreshedSource.sequenceParentId
    ? buildAnnotationSequences(next).find(
        (sequence) => sequence.parentAnnotationId === refreshedSource.sequenceParentId,
      )
    : undefined
  const orderedIds = sourceSequence?.annotationIds.slice() || [sourceId]
  const sourceIndex = Math.max(0, orderedIds.indexOf(sourceId))
  orderedIds.splice(sourceIndex + 1, 0, targetId)

  next = next.map((annotation) =>
    orderedIds.includes(annotation.id) ? clearSequence(annotation) : annotation,
  )
  return normalizeGroup(next, orderedIds)
}

export function removeAnnotationFromSequences<T extends ProjectAnnotation>(
  annotations: readonly T[],
  annotationId: string,
): T[] {
  return unlinkAnnotation(annotations, annotationId).filter(
    (annotation) => annotation.id !== annotationId,
  )
}

export function annotationSequencePosition(
  annotations: readonly ProjectAnnotation[],
  annotationId: string,
): { parentAnnotationId: string; index: number; total: number } | null {
  for (const sequence of buildAnnotationSequences(annotations)) {
    const index = sequence.annotationIds.indexOf(annotationId)
    if (index >= 0) return { parentAnnotationId: sequence.parentAnnotationId, index, total: sequence.annotationIds.length }
  }
  return null
}
