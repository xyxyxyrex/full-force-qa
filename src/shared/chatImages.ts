export const MAX_CHAT_IMAGES = 4
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024
export const CHAT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
export interface ChatImage {
  id: string
  name: string
  mimeType: 'image/webp'
  width: number
  height: number
  bytes: number
}
export interface ChatImageUpload {
  name: string
  bytes: Uint8Array
}
