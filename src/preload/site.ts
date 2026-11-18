import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('socialHubNotification', {
  clicked: () => ipcRenderer.send('social:notification-click'),
  notify: (data: { title: string; body?: string; tag?: string; icon?: string }) => {
    if (!data || typeof data !== 'object') return
    ipcRenderer.send('social:chat-notification', {
      title: typeof data.title === 'string' ? data.title : '',
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: typeof data.icon === 'string' ? data.icon : undefined
    })
  }
})

// --- Incoming WhatsApp Call Detector ---

interface DetectedCall {
  element: HTMLElement
  callType: 'voice' | 'video'
  callerName?: string
  acceptButton?: HTMLElement
  declineButton?: HTMLElement
}

const CALL_STATUS_REGEX =
  /^(incoming|voice|video|audio|call|calls|calling|whatsapp|appel|vocal|vidéo|entrant|llamada|entrante|chamada|recebida|eingehend|sprachanruf|videoanruf|answer|accept|decline|reject|atender|responder|recusar|rechazar|ablehnen|annehmen|ringing|sonando|sonnerie|dismiss|ignore|wordmark|wa-wordmark|logo|icon|button|available|now)$/i

const GENERIC_PHRASE_REGEX =
  /\b(voice and video|video and voice|calling is now available|is now available|end-to-end encrypted|end-to-end encryption|download whatsapp|use whatsapp|make calls|send and receive|keep your phone|whatsapp web|incoming call|incoming voice|incoming video|voice call|video call|audio call|appel vocal|appel vidéo|llamada de voz|videollamada|anruf|wa-wordmark|wordmark)\b/i

function isValidCallerName(raw: string): boolean {
  if (!raw) return false
  const trimmed = raw.trim()
  if (trimmed.length < 1 || trimmed.length > 80) return false
  if (/wordmark/i.test(trimmed)) return false
  if (GENERIC_PHRASE_REGEX.test(trimmed)) return false
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(trimmed)) return false
  if (/^\d+$/.test(trimmed)) return false
  if (CALL_STATUS_REGEX.test(trimmed)) return false

  const words = trimmed.toLowerCase().split(/\s+/)
  const isAllStatusWords = words.every((w) => {
    const cleanedWord = w.replace(/[^\p{L}\p{N}]/gu, '')
    return !cleanedWord || CALL_STATUS_REGEX.test(cleanedWord)
  })
  if (isAllStatusWords) return false
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return false
  return true
}

function isUnrelatedPageArea(el: Element): boolean {
  return Boolean(
    el.closest(
      '#main, #side, #pane-side, [data-testid="chat-list"], [data-testid="cell-frame-title"], [data-testid*="chat-list-item"], [data-testid="intro-title"], [data-testid="conversation-panel-wrapper"], nav, footer'
    )
  )
}

function sanitizeCallerCandidate(el: HTMLElement): string | undefined {
  if (isUnrelatedPageArea(el)) {
    return undefined
  }
  if (el.closest('button, [role="button"], [data-icon], svg, [data-testid*="icon" i]')) {
    return undefined
  }
  const titleAttr = (el.getAttribute('title') || '').trim()
  if (titleAttr && isValidCallerName(titleAttr)) {
    return titleAttr
  }
  const text = (el.innerText || el.textContent || '').trim()
  if (text && isValidCallerName(text)) {
    return text
  }
  return undefined
}

function getCallScope(container: HTMLElement, acc?: HTMLElement, dec?: HTMLElement): HTMLElement | null {
  if (acc && acc.parentElement) {
    // 1. Check if acc is inside an explicit modal/dialog/popup container
    const modal = acc.parentElement.closest<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [data-animate-modal-popup="true"], [data-animate-dropdown-popup="true"], [data-testid*="call-modal" i], [data-testid*="call-dialog" i], [data-testid*="incoming" i], [data-testid*="popup" i]'
    )
    if (
      modal &&
      !modal.querySelector('#pane-side, #side, [data-testid="chat-list"], [data-testid="intro-title"]') &&
      !isUnrelatedPageArea(modal)
    ) {
      return modal
    }

    // 2. Lowest Common Ancestor between acc and dec
    if (dec) {
      const lca = getLowestCommonAncestor(acc, dec)
      if (
        lca &&
        lca !== document.body &&
        lca.id !== 'app' &&
        lca.tagName !== 'HTML' &&
        !lca.querySelector('#pane-side, #side, [data-testid="chat-list"], [data-testid="intro-title"]') &&
        !isUnrelatedPageArea(lca)
      ) {
        // Climb up LCA at most 2 levels if parent stays isolated from unrelated page areas
        let curr: HTMLElement = lca
        let parent = curr.parentElement
        for (let i = 0; i < 2 && parent; i++) {
          if (
            parent === document.body ||
            parent.id === 'app' ||
            parent.tagName === 'HTML' ||
            parent.querySelector('#pane-side, #side, [data-testid="chat-list"], [data-testid="intro-title"]') ||
            isUnrelatedPageArea(parent)
          ) {
            break
          }
          curr = parent
          parent = curr.parentElement
        }
        return curr
      }
    }
  }

  // 3. Fallback container if it is isolated from chat list and intro
  if (
    container &&
    container !== document.body &&
    container.id !== 'app' &&
    container.tagName !== 'HTML' &&
    !container.querySelector('#pane-side, #side, [data-testid="chat-list"], [data-testid="intro-title"]') &&
    !isUnrelatedPageArea(container)
  ) {
    return container
  }

  return null
}

function extractCallerName(container: HTMLElement, acc?: HTMLElement, dec?: HTMLElement): string | undefined {
  const scope = getCallScope(container, acc, dec)
  if (!scope) {
    return undefined
  }

  // 1. High-priority caller-specific elements inside scope
  const highPriority = scope.querySelectorAll<HTMLElement>(
    '[data-testid*="caller" i], [data-testid*="contact-name" i], [data-testid*="call-title" i]'
  )
  for (const el of highPriority) {
    const name = sanitizeCallerCandidate(el)
    if (name) return name
  }

  // 2. Caller profile image alt attribute inside scope
  const avatarImgs = scope.querySelectorAll<HTMLImageElement>('img[alt]')
  for (const img of avatarImgs) {
    if (isUnrelatedPageArea(img)) continue
    const rawAlt = (img.getAttribute('alt') || '').trim()
    if (!rawAlt) continue
    const cleanedAlt = rawAlt
      .replace(/\b(profile photo of|profile picture of|photo de profil de|foto del perfil de)\b/i, '')
      .replace(/('s profile photo|'s profile picture)$/i, '')
      .trim()
    if (cleanedAlt && isValidCallerName(cleanedAlt)) {
      return cleanedAlt
    }
  }

  // 3. Headings inside scope (h2, h3, [role="heading"])
  const headings = scope.querySelectorAll<HTMLElement>('[role="heading"], h2, h3')
  for (const el of headings) {
    const name = sanitizeCallerCandidate(el)
    if (name) return name
  }

  // 4. Candidate name or title elements inside scope
  const candidates = scope.querySelectorAll<HTMLElement>(
    '[data-testid*="name" i], span[title], div[title], span[dir="auto"], div[dir="auto"]'
  )
  for (const el of candidates) {
    const name = sanitizeCallerCandidate(el)
    if (name) return name
  }

  return undefined
}

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
  // 1. Search candidate containers first (strictly localized dialogs and call popups)
  const candidateSelectors = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[data-animate-modal-popup="true"]',
    '[data-animate-dropdown-popup="true"]',
    '[data-testid*="call" i]',
    '[data-testid*="popup" i]',
    '[data-testid*="incoming" i]'
  ]
  const candidates = document.querySelectorAll<HTMLElement>(candidateSelectors.join(', '))

  let foundContainer: HTMLElement | null = null
  let acceptBtn: HTMLElement | null = null
  let declineBtn: HTMLElement | null = null

  for (const candidate of candidates) {
    if (candidate.querySelector('#pane-side, #side, [data-testid="chat-list"], [data-testid="intro-title"]')) {
      continue
    }
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
    const allAcc = document.querySelectorAll<HTMLElement>(ACCEPT_SELECTOR)
    const allDec = document.querySelectorAll<HTMLElement>(DECLINE_SELECTOR)
    for (const acc of allAcc) {
      if (isUnrelatedPageArea(acc)) continue
      for (const dec of allDec) {
        if (isUnrelatedPageArea(dec)) continue
        const lca = getLowestCommonAncestor(acc, dec)
        if (
          lca &&
          lca !== document.body &&
          lca.id !== 'app' &&
          lca.tagName !== 'HTML' &&
          !lca.querySelector('#pane-side, #side, [data-testid="chat-list"], [data-testid="intro-title"]')
        ) {
          foundContainer = lca
          acceptBtn = acc
          declineBtn = dec
          break
        }
      }
      if (foundContainer) break
    }
  }

  // 3. Guaranteed Fallback: if both buttons exist anywhere in document, never fail call detection!
  if (!foundContainer) {
    const acc = document.querySelector<HTMLElement>(ACCEPT_SELECTOR)
    const dec = document.querySelector<HTMLElement>(DECLINE_SELECTOR)
    if (acc && dec) {
      foundContainer = acc.parentElement || acc
      acceptBtn = acc
      declineBtn = dec
    }
  }

  if (foundContainer) {
    const scope = getCallScope(foundContainer, acceptBtn ?? undefined, declineBtn ?? undefined) || foundContainer
    const textContent = (scope.innerText || scope.textContent || '').toLowerCase()
    const hasVideoIcon = Boolean(
      scope.querySelector('[data-icon*="video" i], [data-icon*="camera" i], [data-testid*="video" i], svg[aria-label*="video" i]')
    )
    const hasVideoText = /\b(video call|incoming video|vidéo|videollamada|vídeo|videoanruf)\b/i.test(textContent)
    const callType: 'voice' | 'video' = hasVideoIcon || hasVideoText ? 'video' : 'voice'

    // Separate caller-name extraction from call detection
    let callerName: string | undefined
    try {
      callerName = extractCallerName(foundContainer, acceptBtn ?? undefined, declineBtn ?? undefined)
    } catch (err) {
      console.warn('[CALL][PRELOAD] Caller extraction error (safe fallback):', err)
      callerName = undefined
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

  let activeCall: { callId: string; element: HTMLElement; callerName?: string } | null = null
  let checkScheduled = false

  const checkCallState = () => {
    checkScheduled = false
    const detected = findIncomingCallModal()

    if (detected && !activeCall) {
      const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      activeCall = { callId, element: detected.element, callerName: detected.callerName }

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
    } else if (detected && activeCall) {
      activeCall.element = detected.element
      if (!activeCall.callerName) {
        let resolvedName: string | undefined
        try {
          resolvedName =
            detected.callerName ||
            extractCallerName(detected.element, detected.acceptButton, detected.declineButton) ||
            extractCallerName(activeCall.element)
        } catch {
          resolvedName = undefined
        }
        if (resolvedName) {
          activeCall.callerName = resolvedName
          console.log(`[CALL][PRELOAD] Caller name resolved after call start: ${resolvedName}`)
          ipcRenderer.send('hub:incoming-call-update', {
            callId: activeCall.callId,
            callerName: resolvedName
          })
        }
      }
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
