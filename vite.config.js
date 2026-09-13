import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: '/BettyBridgeGame/',
  build: {
    // Betty's iPad decides this, not the toolchain. Vite's default assumes a
    // browser as new as Safari 16; an older iPad Air would get syntax it
    // cannot parse and show nothing but a white screen. Pinning the target
    // means the build fails loudly here rather than silently on her iPad.
    target: ['safari14', 'chrome87', 'firefox78']
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: {
        enabled: true
      },
      manifest: {
        name: 'BettyBridge',
        short_name: 'BettyBridge',
        description: 'An accessible Duplicate Bridge game',
        theme_color: '#1b6a38',
        background_color: '#0d381c',
        display: 'standalone',
        icons: [
          {
            src: 'icon.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ],
})
