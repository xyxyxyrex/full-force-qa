import { describe, expect, it } from 'vitest'
import type { ProjectAnnotation } from './types'
import {
  annotationSequencePosition,
  buildAnnotationSequences,
  linkAnnotations,
  removeAnnotationFromSequences,
  unlinkAnnotation,
} from './annotationSequences'

const annotation = (id: string, badgeNumber: number): ProjectAnnotation => ({
  id,
  badgeNumber,
  title: id,
  notes: '',
  color: '#ff0055',
  rectPct: { x: 0, y: 0, width: 10, height: 10 },
})

describe('annotation sequences', () => {
  it('creates a sequence with the first linked annotation as parent', () => {
    const linked = linkAnnotations([annotation('a', 1), annotation('b', 2)], 'a', 'b')
    expect(buildAnnotationSequences(linked)).toEqual([
      { parentAnnotationId: 'a', annotationIds: ['a', 'b'] },
    ])
    expect(annotationSequencePosition(linked, 'b')).toEqual({ parentAnnotationId: 'a', index: 1, total: 2 })
  })

  it('inserts a target immediately after the source', () => {
    let annotations = [annotation('a', 1), annotation('b', 2), annotation('c', 3)]
    annotations = linkAnnotations(annotations, 'a', 'b')
    annotations = linkAnnotations(annotations, 'a', 'c')
    expect(buildAnnotationSequences(annotations)[0].annotationIds).toEqual(['a', 'c', 'b'])
  })

  it('moves an annotation between sequences without leaving invalid groups', () => {
    let annotations = [annotation('a', 1), annotation('b', 2), annotation('c', 3), annotation('d', 4)]
    annotations = linkAnnotations(annotations, 'a', 'b')
    annotations = linkAnnotations(annotations, 'c', 'd')
    annotations = linkAnnotations(annotations, 'b', 'd')
    expect(buildAnnotationSequences(annotations)).toEqual([
      { parentAnnotationId: 'a', annotationIds: ['a', 'b', 'd'] },
    ])
    expect(annotations.find((item) => item.id === 'c')?.sequenceParentId).toBeUndefined()
  })

  it('promotes the next item when a parent is unlinked or deleted', () => {
    let annotations = [annotation('a', 1), annotation('b', 2), annotation('c', 3)]
    annotations = linkAnnotations(annotations, 'a', 'b')
    annotations = linkAnnotations(annotations, 'b', 'c')
    const unlinked = unlinkAnnotation(annotations, 'a')
    expect(buildAnnotationSequences(unlinked)).toEqual([
      { parentAnnotationId: 'b', annotationIds: ['b', 'c'] },
    ])
    const removed = removeAnnotationFromSequences(annotations, 'a')
    expect(buildAnnotationSequences(removed)).toEqual([
      { parentAnnotationId: 'b', annotationIds: ['b', 'c'] },
    ])
  })
})
