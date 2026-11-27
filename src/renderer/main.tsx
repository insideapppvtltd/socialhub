import React from 'react'
import ReactDOM from 'react-dom/client'
import { initializePlatformBridge } from './platform/hub-bridge'
import App from './App'
import './styles.css'

initializePlatformBridge()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
