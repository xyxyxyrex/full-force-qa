import { describe, expect, it } from 'vitest'
import { QA_AGENT_PROMPT, QA_FUNCTIONAL, QA_RUBRIC, QA_RUBRIC_STANDALONE } from './prompt'

const ALL = { QA_AGENT_PROMPT, QA_FUNCTIONAL, QA_RUBRIC, QA_RUBRIC_STANDALONE }

describe('QA prompts', () => {
  it('never send the agent off to ask for a design', () => {
    for (const [name, prompt] of Object.entries(ALL)) {
      expect(prompt, name).not.toMatch(/add the figma|(?<!never )ask (the person )?for (a|the) (figma|design)|no design for a breakpoint you were asked/i)
    }
    expect(QA_RUBRIC).toContain('never a reason to stop or to ask for one')
  })

  it('ask for the agent\'s own suggestions, kept apart as ENHANCEMENT (QA) rows', () => {
    for (const [name, prompt] of Object.entries(ALL)) {
      expect(prompt, name).toContain('# Your own suggestions')
      expect(prompt, name).toContain('"ENHANCEMENT (QA)"')
    }
  })

  it('tell the tester how sending works and where its findings go', () => {
    expect(QA_FUNCTIONAL).toContain('browser_open says whether sending is on')
    expect(QA_FUNCTIONAL).toContain('save_draft with area "functional"')
    expect(QA_FUNCTIONAL).toContain('screenshot: "B3"')
  })
})
