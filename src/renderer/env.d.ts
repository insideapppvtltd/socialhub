import type { SocialHubAPI } from '../preload'

declare global {
  interface Window {
    socialHub: SocialHubAPI
  }
}

export {}
