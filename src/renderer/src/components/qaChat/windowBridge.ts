import type { QaChatWindowAction } from '../../../../shared/qaChatWindow'
import { qaChat } from '../qaChatStore'

export function handleChatWindowAction(action: QaChatWindowAction) {
  switch (action.type) {
    case 'user': qaChat.addUserMessage(action.text); break
    case 'status': qaChat.addStatus(action.text); break
    case 'error': qaChat.addError(action.text); break
    case 'event': qaChat.handle(action.event); break
    case 'clear': qaChat.clear(); break
    case 'draft': qaChat.setDraft(action.input, action.tab); break
    case 'open': {
      if (action.view === 'settings') window.dispatchEvent(new CustomEvent('parity:settings-section', { detail: 'agents' }))
      else window.dispatchEvent(new CustomEvent(action.view === 'history' ? 'parity:open-qa-history' : 'parity:open-ai-tracker', { detail: { tab: action.tab, projectKey: action.projectKey } }))
      break
    }
  }
}
