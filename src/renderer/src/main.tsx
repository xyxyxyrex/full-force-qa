import ReactDOM from 'react-dom/client'
import App from './App'
import './App.css'
import SiteAuthDialog from './components/SiteAuthDialog'
import DetachedChat from './components/qaChat/DetachedChat'
import { applyTheme, loadSettings } from './theme/themeSystem'

const siteAuth = new URLSearchParams(location.search).get('siteAuth') === '1'
if (siteAuth) applyTheme(loadSettings().theme)

ReactDOM.createRoot(document.getElementById('root')!).render(
  siteAuth ? <SiteAuthDialog standalone /> : new URLSearchParams(location.search).get('qaChat') === '1' ? <DetachedChat /> : <App />
)
