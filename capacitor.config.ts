import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.socialhub.android',
  appName: 'Social Hub',
  webDir: 'dist-android',
  android: {
    allowMixedContent: false
  }
}

export default config
