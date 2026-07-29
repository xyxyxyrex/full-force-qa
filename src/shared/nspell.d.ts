declare module 'nspell' {
  interface NSpellInstance {
    correct(word: string): boolean
    suggest(word: string): string[]
    add(word: string): void
    remove(word: string): void
  }
  function nspell(dict: any): NSpellInstance
  function nspell(aff: any, dic: any): NSpellInstance
  export default nspell
}

declare module 'dictionary-en' {
  function dictionaryEn(callback: (err: any, dict: { aff: any; dic: any }) => void): void
  export default dictionaryEn
}
