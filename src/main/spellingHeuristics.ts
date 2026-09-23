interface DictionaryLike { correct: (word: string) => boolean; suggest?: (word: string) => string[] }

/** Accept dictionary words and regular plurals of dictionary words. */
export function isAcceptedSpelling(dictionary: DictionaryLike | null, word: string): boolean {
  if (!dictionary || !/^[A-Za-z]+$/.test(word)) return false
  const lower = word.toLowerCase()
  if (dictionary.correct(word) || dictionary.correct(lower)) return true
  if (!lower.endsWith('s') || lower.length <= 3) return false
  const singular = lower.slice(0, -1)
  if (!dictionary.correct(singular)) return false
  // Only suppress the false positive when the dictionary itself proposes
  // possessive punctuation for this regular plural. This keeps "thes" flagged.
  return Boolean(dictionary.suggest?.(word).some((suggestion) => suggestion.toLowerCase() === `${singular}'s`))
}
