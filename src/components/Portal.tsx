// src/components/Portal.tsx
// Renders children into document.body so they escape ancestor stacking
// contexts (e.g. the side rail's backdrop-filter, which would otherwise
// trap a position:fixed drawer inside the rail's 56px column).

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Portal({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (typeof document === 'undefined') return
    const el = document.createElement('div')
    el.dataset.portal = 'overlay'
    el.style.position = 'relative'
    el.style.zIndex = '1000'
    document.body.appendChild(el)
    setHost(el)
    return () => {
      document.body.removeChild(el)
    }
  }, [])

  if (!host) return null
  return createPortal(children, host)
}
