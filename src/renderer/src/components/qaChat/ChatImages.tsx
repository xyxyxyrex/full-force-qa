import { useEffect, useRef, useState } from 'react'
import type { ChatImage } from '../../../../shared/chatImages'
import { PictureLightbox, type FindingPicture } from '../QaFindings'
import ChatIcon from './ChatIcon'

export default function ChatImages({ chatId, images, remove }: { chatId: string | null; images: ChatImage[]; remove?: (id: string) => void }) {
  const [pictures, setPictures] = useState<Record<string, FindingPicture>>({})
  const [failed, setFailed] = useState<string[]>([])
  const [zoom, setZoom] = useState<FindingPicture | null>(null)
  const [retry, setRetry] = useState(0)
  const [opening, setOpening] = useState('')
  const alive = useRef(true)
  const generation = useRef(0)
  const ids = images.map(image => image.id).join('/')
  useEffect(() => {
    let alive = true
    generation.current++
    setPictures({}); setFailed([]); setZoom(null); setOpening('')
    if (chatId) images.forEach(image => {
      void window.electronAPI.qaChatImagesPicture(chatId, image.id).then(picture => { if (alive) setPictures(previous => ({ ...previous, [image.id]: picture })) }).catch(() => { if (alive) setFailed(previous => [...previous, image.id]) })
    })
    return () => { alive = false }
  }, [chatId, ids, retry])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const enlarge = async (image: ChatImage) => {
    if (!chatId || opening) return
    const version = generation.current
    setOpening(image.id)
    try { const full = await window.electronAPI.qaChatImagesPicture(chatId, image.id, true); if (alive.current && version === generation.current) setZoom(full) }
    catch { if (alive.current && version === generation.current) setZoom(pictures[image.id] || null) }
    finally { if (alive.current && version === generation.current) setOpening('') }
  }
  if (!images.length) return null
  return <>
    <div className="qa-chat-images" role="list" aria-label={remove ? 'Attached images' : 'Images in this message'}>
      {images.map(image => <div className="qa-chat-image" role="listitem" key={image.id}>
        <button type="button" className="qa-chat-image-view" aria-label={`View image ${image.name}`} title={`${image.name} · ${image.width}×${image.height}`} aria-busy={opening === image.id} disabled={!!opening || (!pictures[image.id] && !failed.includes(image.id))} onClick={() => pictures[image.id] ? void enlarge(image) : setRetry(value => value + 1)}>
          {pictures[image.id] ? <img src={pictures[image.id].src} alt={image.name}/> : <span className="qa-chat-image-placeholder">{failed.includes(image.id) ? 'Retry' : 'Loading…'}</span>}
          <span className="qa-chat-image-name">{image.name}</span>
        </button>
        {remove && <button type="button" className="qa-chat-image-remove" aria-label={`Remove image ${image.name}`} title="Remove image" onClick={() => remove(image.id)}><ChatIcon name="close" size={12}/></button>}
      </div>)}
    </div>
    <PictureLightbox picture={zoom} onClose={() => setZoom(null)}/>
  </>
}
