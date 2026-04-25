import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './styles/global.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Navigate to="/a/minor-pentatonic/1" replace />} />
        <Route path="/:keySlug/:scaleId/:positionIdx" element={<App />} />
        <Route path="/:keySlug/:scaleId" element={<App />} />
        <Route path="*" element={<Navigate to="/a/minor-pentatonic/1" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
