declare module 'harper.js' {
  export interface LintResult {
    span(): { start: number; end: number }
    message(): string
    suggestions(): Array<{ replacement_text(): string } | string>
    suggestion_text(): string
    kind(): string
  }

  export class Linter {
    constructor()
    lint(text: string): Promise<LintResult[]>
  }
}
