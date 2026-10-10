import { AGENT_IDS, isAgentId, type QaRunStartOptions } from './qaAgent'
import { BREAKPOINTS, isBreakpoint } from './designScale'
import { PARITY_GUIDE } from './parityGuide'
const REVIEW_FLAGS = ['--no-design', '--visual-only', '--test', '--agent'] as const
export const QA_COMMANDS = [
  {name:'/search',description:'Search your Parity workspace',usage:'/search [words] [--date MM/DD/YY] [--offset N]'},
  {name:'/projects',description:'Find projects',usage:'/projects [words]'},
  {name:'/folders',description:'Find folders',usage:'/folders [words]'},
  {name:'/captures',description:'Find recorded website captures',usage:'/captures [MM/DD/YY] [words]'},
  {name:'/open',description:'Open a discovered item',usage:'/open project|folder|note|ticket|finding|capture "name or ID"'},
  {name:'/create',description:'Preview new projects or a folder',usage:'/create project URL… [--folder "folder"] [--name "name"] | /create folder "name" [--folder "parent"]'},
  {name:'/rename',description:'Preview a project/folder rename',usage:'/rename project|folder "name or ID" "new name"'},
  {name:'/move',description:'Preview moving a project/folder',usage:'/move project|folder "name or ID" "destination folder"'},
  {name:'/trash',description:'Preview moving a project to Trash',usage:'/trash "project name or ID"'},
  {name:'/restore',description:'Preview restoring a project',usage:'/restore "project name or ID"'},
  {name:'/findings',description:'Find saved AI audit items',usage:'/findings [words]'},
  {name:'/notes',description:'Search notes',usage:'/notes [words]'},
  {name:'/tickets',description:'Search tickets',usage:'/tickets [words]'},
  {name:'/context',description:'Show the current Parity workspace',usage:'/context'},
  {name:'/about',description:'Explain a Parity workspace or feature',usage:'/about [topic]'},
  {name:'/agent',description:'Choose the provider/model for this chat',usage:'/agent'},
  { name: '/review', description: 'Review this page and draft findings', usage: '/review [desktop|tablet|mobile] [--no-design] [--visual-only|--test] [--agent ID]' },
  { name: '/stop', description: 'Stop the current request', usage: '/stop' },
  { name: '/new', description: 'Start a new chat; keep this one in History', usage: '/new' },
  { name: '/history', description: 'Open saved chats or reviews', usage: '/history [chats|reviews]' },
  { name: '/agents', description: 'Show available agents and connection status', usage: '/agents' },
  { name: '/usage', description: 'Show token usage recorded in this chat', usage: '/usage' },
  { name: '/quota', description: 'Check provider allowance and reset times', usage: '/quota [agent ID] [--refresh]' },
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
    const matches = QA_COMMANDS.filter(c => c.name.startsWith(input.toLowerCase())).sort((a,b)=>Number(b.name==='/review')-Number(a.name==='/review'))
    const choices = matches.length ? matches : [...QA_COMMANDS].filter(c=>distance(input.toLowerCase(),c.name)<=3).sort((a,b)=>distance(input,a.name)-distance(input,b.name)).slice(0,3)
    return choices.map(c => ({ value:c.name+' ',label:c.name,description:c.description }))
  }
  const prefix = words.slice(0, -1).join(' ') + ' '
  const query = words.at(-1) || ''
  const options = words[0] === '/quota' ? [...AGENT_IDS, '--refresh'] : words[0] === '/review' ? words.at(-2) === '--agent' ? [...AGENT_IDS] : [...BREAKPOINTS, ...REVIEW_FLAGS] : words[0] === '/history' ? ['chats', 'reviews'] : words[0]==='/about'?Object.keys(PARITY_GUIDE):['/create','/rename','/move'].includes(words[0])?['project','folder','--folder','--name']:words[0]==='/open'?['project','folder','capture','finding','note','ticket']:['/search','/captures','/projects','/notes','/tickets'].includes(words[0])?['--date','--offset']:[]
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
  const [command, ...args] = tokenizeQaCommand(input)
  if(!command)return null
  if (!command.startsWith('/')) return null
  if (!QA_COMMANDS.some(item => item.name === command)) throw new Error(`Unknown command "${command}".${commandSuggestions(command)[0] ? ` Did you mean ${commandSuggestions(command)[0].label}?` : ''} Use /help or choose a command from the / menu.`)
  if (['/stop','/new','/agents','/help','/agent','/context','/usage'].includes(command) && args.length) throw new Error(`${command} does not take arguments.`)
  if (command === '/quota') parseQuotaArgs(args)
  if (command === '/history' && (args.length > 1 || (args[0] && !['chats', 'reviews'].includes(args[0])))) throw new Error('Use /history chats or /history reviews.')
  return { command, args }
}
export function parseQuotaArgs(args: string[]): { agent?: import('./qaAgent').AgentId; refresh: boolean } {
  let agent: import('./qaAgent').AgentId | undefined, refresh = false
  for (const arg of args) {
    if (arg === '--refresh' && !refresh) refresh = true
    else if (isAgentId(arg) && !agent) agent = arg
    else throw new Error('Use /quota [agent ID] [--refresh]. Type /agents to see provider IDs.')
  }
  return { agent, refresh }
}
export function tokenizeQaCommand(input:string):string[] {
  const tokens:string[]=[];let token='',quote='';let active=false
  for(let i=0;i<input.length;i++){const c=input[i];if(quote){if(c===quote)quote='';else if(c==='\\'&&[quote,'\\'].includes(input[i+1]))token+=input[++i];else token+=c;active=true;continue}if(c==='"'||c==="'"){quote=c;active=true}else if(/\s/.test(c)){if(active){tokens.push(token);token='';active=false}}else{token+=c;active=true}}
  if(quote)throw new Error('Close the quoted name before sending the command.')
  if(active)tokens.push(token);return tokens
}
