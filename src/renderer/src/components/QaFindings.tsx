import { useEffect, type Ref } from 'react'
import type { RowView } from '../../../shared/trackerFormat'
import './QaFindings.css'

// Pieces shared by the approval card and Past reviews: one finding with its picture, a page
// heading, and the enlarged picture.

export interface FindingPicture { src: string; caption: string }

export function shortLink(link: string): string {
  try { const url = new URL(link); return `${url.pathname}${url.search}` || url.host } catch { return link }
}

const severityClass = (value: string) => (/high|critical|major|urgent|p1/i.test(value) ? 'high' : /med/i.test(value) ? 'medium' : /low|minor|p3/i.test(value) ? 'low' : 'other')

interface FindingCardProps {
  index: number
  view: RowView
  /** The picture, `'loading'` while it is being fetched, or nothing. */
  picture?: FindingPicture | 'loading' | null
  /** The link that was put in the screenshot column, once uploaded. */
  link?: string
  excluded?: boolean
  onToggleExcluded?: () => void
  onZoom?: (picture: FindingPicture) => void
  cardRef?: Ref<HTMLLIElement>
}

const badgeClass = (badge: RowView['badges'][number]) =>
  badge.kind === 'severity' ? `sev-${severityClass(badge.value)}` : badge.kind === 'status' ? `status${/enhancement/i.test(badge.value) ? ' suggestion' : ''}` : 'display'

export function FindingCard({ index, view, picture, link, excluded, onToggleExcluded, onZoom, cardRef }: FindingCardProps) {
  return (
    <li ref={cardRef} className={`qa-finding${excluded ? ' excluded' : ''}`}>
      <div className="qa-finding-head">
        <span className="qa-finding-number">{index + 1}</span>
        <strong className="qa-finding-title">{view.title || `Finding ${index + 1}`}</strong>
        {view.badges.map((badge) => <span key={badge.label} className={`qa-badge ${badgeClass(badge)}`} title={badge.label}>{badge.kind === 'status' && /enhancement/i.test(badge.value) ? 'Suggestion' : badge.value}</span>)}
        {onToggleExcluded && (
          <button type="button" className="qa-finding-toggle" onClick={onToggleExcluded} aria-pressed={!!excluded} title={excluded ? 'Copy this finding after all' : 'Do not copy this finding'}>
            {excluded ? 'Put back' : 'Leave out'}
          </button>
        )}
      </div>
      {view.body && view.body !== view.title && <p className="qa-finding-body">{view.body}</p>}
      {view.link && <small className="qa-finding-link" title={view.link}>{shortLink(view.link)}</small>}
      {view.extras.length > 0 && <dl className="qa-finding-extras">{view.extras.map((extra) => <div key={extra.label}><dt>{extra.label}</dt><dd>{extra.value}</dd></div>)}</dl>}
      {picture === 'loading' ? <span className="qa-finding-shot-loading" aria-label="Loading the picture" /> : picture ? (
        <figure className="qa-finding-shot">
          <button type="button" onClick={() => onZoom?.(picture)} aria-label={`Enlarge the picture for finding ${index + 1}`}>
            <img src={picture.src} alt={`Picture for finding ${index + 1}`} />
          </button>
          <figcaption>{picture.caption || 'Design (left) and live page (right)'} · click to enlarge</figcaption>
        </figure>
      ) : <p className="qa-finding-noshot">No picture for this finding.</p>}
      {link && <small className="qa-finding-evidence-link" title="Link in the screenshot column">{link}</small>}
    </li>
  )
}

export function PageHeading({ name, url, count }: { name: string; url: string; count: number }) {
  return (
    <li className="qa-finding-page" aria-label={`Page ${name}`}>
      <strong>{name}</strong>
      <small title={url}>{shortLink(url)} · {count} finding{count === 1 ? '' : 's'}</small>
    </li>
  )
}

export function PictureLightbox({ picture, onClose }: { picture: FindingPicture | null; onClose: () => void }) {
  useEffect(() => {
    if (!picture) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [picture, onClose])
  if (!picture) return null
  return (
    <div className="qa-lightbox" role="dialog" aria-label="Enlarged picture" onClick={onClose}>
      <img src={picture.src} alt={picture.caption || 'Enlarged picture'} />
      <span>{picture.caption} · click or press Esc to close</span>
    </div>
  )
}
