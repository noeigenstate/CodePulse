/**
 * Renderer entry point. Mounts the React {@link App} into the page.
 *
 * @module renderer/main
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App.js'
import './index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
