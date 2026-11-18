import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('socialHubNotification', {
  clicked: () => ipcRenderer.send('social:notification-click')
})

// --- Incoming WhatsApp Call Detector ---

interface DetectedCall {
  element: HTMLElement
  callType: 'voice' | 'video'
  callerName?: string
  acceptButton?: HTMLElement
  declineButton?: HTMLElement
}

const CALL_STATUS_WORDS = /^(incoming|voice|video|call|whatsapp|appel|vocal|vidéo|entrant|llamada|entrante|chamada|recebida|eingehend|sprachanruf|videoanruf|answer|accept|decline|reject|atender|responder|recusar|rechazar|ablehnen|annehmen|ringing|sonando|sonnerie|dismiss|ignore)$/i

const ACCEPT_SELECTOR = [
  '[data-testid*="accept" i]',
  '[data-testid*="answer" i]',
  '[data-testid*="call-accept" i]',
  '[data-icon*="call-answer" i]',
  '[data-icon*="phone-call" i]',
  '[data-icon*="phone-refuse" i]',
  '[data-icon*="accept" i]',
  '[aria-label*="answer" i]',
  '[aria-label*="accept" i]',
  '[aria-label*="atender" i]',
  '[aria-label*="responder" i]',
  '[aria-label*="annehmen" i]',
  '[aria-label*="répondre" i]',
  '[title*="answer" i]',
  '[title*="accept" i]'
].join(', ')

const DECLINE_SELECTOR = [
  '[data-testid*="decline" i]',
  '[data-testid*="reject" i]',
  '[data-testid*="hangup" i]',
  '[data-testid*="call-end" i]',
  '[data-testid*="call-decline" i]',
  '[data-icon*="decline" i]',
  '[data-icon*="hangup" i]',
  '[data-icon*="call-end" i]',
  '[data-icon*="end-call" i]',
  '[data-icon*="phone-down" i]',
  '[aria-label*="decline" i]',
  '[aria-label*="reject" i]',
  '[aria-label*="recusar" i]',
  '[aria-label*="rechazar" i]',
  '[aria-label*="ablehnen" i]',
  '[aria-label*="refuser" i]',
  '[aria-label*="end call" i]',
  '[aria-label*="dismiss" i]',
  '[title*="decline" i]',
  '[title*="reject" i]'
].join(', ')

function getLowestCommonAncestor(a: Node, b: Node): HTMLElement | null {
  const ancestors = new Set<Node>()
  let curr: Node | null = a
  while (curr) {
    ancestors.add(curr)
    curr = curr.parentNode
  }
  curr = b
  while (curr) {
    if (ancestors.has(curr) && curr instanceof HTMLElement) {
      return curr
    }
    curr = curr.parentNode
  }
  return null
}

function findIncomingCallModal(): DetectedCall | null {
  // 1. Search candidate containers first
  const candidates = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [data-animate-modal-popup="true"], [data-animate-dropdown-popup="true"], [data-testid*="call"], [data-testid*="popup"], [data-testid*="incoming"], #app > div > span > div, div[tabindex="-1"]'
  )

  let foundContainer: HTMLElement | null = null
  let acceptBtn: HTMLElement | null = null
  let declineBtn: HTMLElement | null = null

  for (const candidate of candidates) {
    const acc = candidate.querySelector<HTMLElement>(ACCEPT_SELECTOR)
    const dec = candidate.querySelector<HTMLElement>(DECLINE_SELECTOR)

    // Strictly require BOTH Accept and Decline buttons to be present in the call container.
    // Outgoing calls, connected calls, and chat screens only have at most one button.
    if (acc && dec) {
      foundContainer = candidate
      acceptBtn = acc
      declineBtn = dec
      break
    }
  }

  // 2. Fallback: if not found in candidate queries, search document-wide
  // but strictly require that both buttons share a localized common container (not document.body, #app, or html)
  if (!foundContainer) {
    const acc = document.querySelector<HTMLElement>(ACCEPT_SELECTOR)
    const dec = document.querySelector<HTMLElement>(DECLINE_SELECTOR)
    if (acc && dec) {
      const lca = getLowestCommonAncestor(acc, dec)
      if (lca && lca !== document.body && lca.id !== 'app' && lca.tagName !== 'HTML') {
        foundContainer = lca
        acceptBtn = acc
        declineBtn = dec
      }
    }
  }

  if (foundContainer) {
    const textContent = foundContainer.innerText || foundContainer.textContent || ''
    const hasVideoIcon = Boolean(
      foundContainer.querySelector('[data-icon*="video" i], [data-icon*="camera" i], [data-testid*="video" i]')
    )
    const hasVideoText = /\b(video|vidéo|videollamada|vídeo|videoanruf)\b/i.test(textContent)
    const callType: 'voice' | 'video' = hasVideoIcon || hasVideoText ? 'video' : 'voice'

    // Extract caller name from candidate elements
    let callerName: string | undefined
    const titleElements = foundContainer.querySelectorAll<HTMLElement>(
      '[role="heading"], h1, h2, h3, [data-testid*="contact-name"], [data-testid*="caller"], span[title], span[dir="auto"], div[dir="auto"]'
    )
    for (const el of titleElements) {
      const raw = (el.getAttribute('title') || el.innerText || el.textContent || '').trim()
      if (!raw || raw.length > 100) continue
      const cleaned = raw.replace(/[^\p{L}\p{N}\s+]/gu, '').trim()
      if (cleaned && !CALL_STATUS_WORDS.test(cleaned) && !/^\d{1,2}:\d{2}$/.test(cleaned)) {
        callerName = raw
        break
      }
    }

    // Fallback: extract caller name from document.title if WhatsApp set it there
    if (!callerName && document.title) {
      const titleMatch =
        document.title.match(/(?:call from|incoming call from)\s+([^()]+)/i) ||
        document.title.match(/📞\s*([^(]+)/)
      if (titleMatch && titleMatch[1]) {
        const fromTitle = titleMatch[1].trim()
        if (fromTitle && fromTitle.length <= 100 && !CALL_STATUS_WORDS.test(fromTitle)) {
          callerName = fromTitle
        }
      }
    }

    return {
      element: foundContainer,
      callType,
      callerName,
      acceptButton: acceptBtn ?? undefined,
      declineButton: declineBtn ?? undefined
    }
  }

  return null
}

function initWhatsAppCallDetector(): void {
  const isWhatsApp =
    window.location.hostname.includes('whatsapp.com') || window.location.href.includes('whatsapp.com')

  if (!isWhatsApp) {
    // If navigation hasn't committed yet (e.g. initial about:blank), retry shortly
    const retryTimer = setInterval(() => {
      if (window.location.hostname.includes('whatsapp.com') || window.location.href.includes('whatsapp.com')) {
        clearInterval(retryTimer)
        initWhatsAppCallDetector()
      }
    }, 500)
    return
  }

  console.log(`[CALL][PRELOAD] Initializing call detector on ${window.location.href}`)

  let activeCall: { callId: string; element: HTMLElement } | null = null
  let checkScheduled = false

  const checkCallState = () => {
    checkScheduled = false
    const detected = findIncomingCallModal()

    if (detected && !activeCall) {
      const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      activeCall = { callId, element: detected.element }

      console.log(
        `[CALL][PRELOAD] Detected incoming call at ${new Date().toISOString()} | callId: ${callId} | type: ${detected.callType} | caller: ${detected.callerName ?? 'Unknown'}`
      )

      const onUserAction = () => {
        if (activeCall && activeCall.callId === callId) {
          console.log(`[CALL][PRELOAD] User clicked in-page call action button for callId: ${callId}`)
          ipcRenderer.send('hub:incoming-call-end', { callId })
          activeCall = null
        }
      }

      detected.acceptButton?.addEventListener('click', onUserAction, { once: true })
      detected.declineButton?.addEventListener('click', onUserAction, { once: true })

      ipcRenderer.send('hub:incoming-call-start', {
        callId,
        callerName: detected.callerName,
        callType: detected.callType
      })
    } else if (!detected && activeCall) {
      console.log(`[CALL][PRELOAD] Incoming call modal dismissed for callId: ${activeCall.callId}`)
      ipcRenderer.send('hub:incoming-call-end', { callId: activeCall.callId })
      activeCall = null
    }
  }

  const scheduleCheck = () => {
    if (checkScheduled) return
    checkScheduled = true
    queueMicrotask(() => {
      checkScheduled = false
      checkCallState()
    })
  }

  const observer = new MutationObserver(() => {
    scheduleCheck()
  })

  const startObserving = () => {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true })
      scheduleCheck()
    } else {
      document.addEventListener('DOMContentLoaded', startObserving, { once: true })
    }
  }

  startObserving()

  // Watch for page title changes (corroborating incoming call alerts)
  const titleEl = document.querySelector('title')
  if (titleEl) {
    new MutationObserver(() => {
      if (/📞|incoming.*call|call.*from/i.test(document.title)) {
        scheduleCheck()
      }
    }).observe(titleEl, { childList: true, characterData: true, subtree: true })
  }

  // Fallback periodic sweep every 1 second
  setInterval(() => {
    if (activeCall) {
      checkCallState()
    }
  }, 1000)

  window.addEventListener('beforeunload', () => {
    if (activeCall) {
      console.log(`[CALL][PRELOAD] Page unloading, ending active call: ${activeCall.callId}`)
      ipcRenderer.send('hub:incoming-call-end', { callId: activeCall.callId })
      activeCall = null
    }
  })
}

try {
  initWhatsAppCallDetector()
} catch (error) {
  console.error('[CALL][PRELOAD] Failed to initialize WhatsApp call detector:', error)
}
