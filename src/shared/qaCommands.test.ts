import { describe, expect, it } from 'vitest'
import { commandSuggestions, parseQaCommand, parseQuotaArgs, QA_COMMANDS, qaCommandHelp } from './qaCommands'
describe('chat commands',()=>{
  it('discovers usage/quota and validates provider and refresh arguments locally', () => {
    expect(commandSuggestions('/us')[0].label).toBe('/usage')
    expect(commandSuggestions('/quota cod')[0].label).toBe('codex')
    expect(parseQuotaArgs(['--refresh', 'codex'])).toEqual({ agent: 'codex', refresh: true })
    expect(parseQaCommand('/quota')).toEqual({ command: '/quota', args: [] })
    expect(() => parseQaCommand('/usage codex')).toThrow()
    expect(() => parseQaCommand('/quota unknown')).toThrow()
    expect(() => parseQaCommand('/quota codex claude-code')).toThrow()
    expect(() => parseQaCommand('/quota --refresh --refresh')).toThrow()
  })
  it('uses one registry for suggestions and help',()=>{expect(commandSuggestions('/')).toHaveLength(QA_COMMANDS.length);for(const item of QA_COMMANDS)expect(qaCommandHelp()).toContain(item.name)})
  it('suggests review flags, agents, and history tabs',()=>{expect(commandSuggestions('/review --a')[0].label).toBe('--agent');expect(commandSuggestions('/review --agent cod')[0].label).toBe('codex');expect(commandSuggestions('/history c')[0].label).toBe('chats')})
  it('rejects unknown commands and incorrect arguments locally',()=>{expect(()=>parseQaCommand('/reviw')).toThrow('Unknown command');expect(()=>parseQaCommand('/history nonsense')).toThrow();expect(parseQaCommand('check this')).toBeNull()})
})
