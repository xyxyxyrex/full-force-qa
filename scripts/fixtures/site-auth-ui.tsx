import { createRoot } from 'react-dom/client'
import SiteAuthDialog from '../../src/renderer/src/components/SiteAuthDialog'
import '../../src/renderer/src/theme/themes.css'

createRoot(document.getElementById('root')!).render(<SiteAuthDialog standalone={new URLSearchParams(location.search).has('standalone')} />)
