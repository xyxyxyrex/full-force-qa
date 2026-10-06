export interface SiteAuthRequest {
  id: string
  origin: string
  realm: string
  scheme: string
  isProxy: boolean
  retry: boolean
}

export interface SiteCredentials { username: string; password: string }
