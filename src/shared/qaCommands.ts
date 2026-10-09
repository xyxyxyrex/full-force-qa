import { AGENT_IDS, isAgentId, type QaRunStartOptions } from './qaAgent'
import { BREAKPOINTS, isBreakpoint } from './designScale'
const REVIEW_FLAGS = ['--no-design', '--visual-only', '--test', '--agent'] as const
export const QA_COMMANDS = [
  { name: '/review', description: 'Review this page and draft findings', usage: '/review [desktop|tablet|mobile] [--no-design] [--visual-only|--test] [--agent ID]' },
  { name: '/stop', description: 'Stop the current request', usage: '/stop' },
  { name: '/new', description: 'Start a new chat; keep this one in History', usage: '/new' },
  { name: '/history', description: 'Open saved chats or reviews', usage: '/history [chats|reviews]' },
  { name: '/agents', description: 'Show available agents and connection status', usage: '/agents' },
  { name: '/help', description: 'Show commands and examples', usage: '/help' },
] as const
export const qaCommandHelp = () => '### Commands\n\n' + QA_COMMANDS.map(command => `- \`${command.usage}\` — ${command.description}`).join('\n') + '\n\nUse Enter to send, Shift+Enter for a new line. Reviews support designs or standalone checks; `--visual-only` skips functional testing.'
const distance = (a: string, b: string) => {
  let row = Array.from({length:b.length+1},(_value,index)=>index)
  for (let i=1;i<=a.length;i++) { const next=[i]; for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1)); row=next }
  return row[b.length]
}
export function commandSuggestions(input: string): Array<{ value: string; label: string; description: string }> {
  if (!input.startsWith('/')) return []
  const words = input.split(/\s+/)
  if (words.length === 1) {
    const matches = QA_COMMANDS.filter(c => c.name.startsWith(input.toLowerCase()))
    const choices = matches.length ? matches : [...QA_COMMANDS].filter(c=>distance(input.toLowerCase(),c.name)<=3).sort((a,b)=>distance(input,a.name)-distance(input,b.name)).slice(0,3)
    return choices.map(c => ({ value:c.name+' ',label:c.name,description:c.description }))
  }
  const prefix = words.slice(0, -1).join(' ') + ' '
  const query = words.at(-1) || ''
  const options = words[0] === '/review' ? words.at(-2) === '--agent' ? [...AGENT_IDS] : [...BREAKPOINTS, ...REVIEW_FLAGS] : words[0] === '/history' ? ['chats', 'reviews'] : []
  return options.filter(option => option.startsWith(query) && (!words.slice(1, -1).includes(option) || words.at(-2) === '--agent')).map(option => ({ value: prefix + option + ' ', label: option, description: words.at(-2) === '--agent' ? 'Use this agent for the review' : 'Command option' }))
}
export function parseReviewArgs(words: string[]): QaRunStartOptions {
  const result: QaRunStartOptions = {}; const breakpoints: NonNullable<QaRunStartOptions['breakpoints']> = []
  for (let index = 0; index < words.length; index++) {
    const value = words[index]
    if (isBreakpoint(value)) { if (!breakpoints.includes(value)) breakpoints.push(value); continue }
    if (!(REVIEW_FLAGS as readonly string[]).includes(value)) throw new Error(`Unknown option "${value}". Breakpoints are: ${BREAKPOINTS.join(', ')}.`)
    if (value === '--agent') { const agent = words[++index]; if (!isAgentId(agent)) throw new Error(`Unknown agent "${agent || ''}". Type /agents to see the ids.`); result.agent = agent }
    if (value === '--no-design') result.standalone = true
    if (value === '--visual-only') result.functional = false
    if (value === '--test') result.functional = true
  }
  if (words.includes('--visual-only') && words.includes('--test')) throw new Error('--test and --visual-only cannot go together.')
  if (breakpoints.length) result.breakpoints = breakpoints
  return {agent:result.agent,breakpoints:breakpoints.length ? breakpoints : undefined,...(result.standalone ? {standalone:true} : {}),...(result.functional !== undefined ? {functional:result.functional} : {})}
}
export function parseQaCommand(input: string) {
  const [command, ...args] = input.trim().split(/\s+/)
  if (!command.startsWith('/')) return null
  if (!QA_COMMANDS.some(item => item.name === command)) throw new Error(`Unknown command "${command}".${commandSuggestions(command)[0] ? ` Did you mean ${commandSuggestions(command)[0].label}?` : ''} Use /help or choose a command from the / menu.`)
  if (!['/review', '/history'].includes(command) && args.length) throw new Error(`${command} does not take arguments.`)
  if (command === '/history' && (args.length > 1 || (args[0] && !['chats', 'reviews'].includes(args[0])))) throw new Error('Use /history chats or /history reviews.')
  return { command, args }
}
