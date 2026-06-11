/**
 * 渲染端入口。把 React {@link App} 挂载到页面上。
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
