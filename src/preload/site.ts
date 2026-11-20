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

// --- Password Manager Support (Auto-detection, Suggestion, and Auto-save) ---

function initPasswordManagerSupport(): void {
  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function isOtpInput(el: HTMLInputElement): boolean {
    if (el.getAttribute('autocomplete') === 'one-time-code') return true
    const haystack = `${el.name} ${el.id} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('autocomplete') || ''}`.toLowerCase()
    return /\b(otp|2fa|mfa|totp|passcode|verification|verification-code|security-code)\b/i.test(haystack)
  }

  function isCreditCardInput(el: HTMLInputElement): boolean {
    const haystack = `${el.name} ${el.id} ${el.getAttribute('autocomplete') || ''}`.toLowerCase()
    return /\b(card|cc-|cvv|cvc|exp|exp-month|exp-year)\b/i.test(haystack)
  }

  function findAssociatedInputs(target: HTMLInputElement): {
    usernameInput: HTMLInputElement | null
    passwordInput: HTMLInputElement | null
  } {
    let form = target.closest('form')
    if (!form) {
      form = target.closest<HTMLFormElement>(
        '[role="form"], [data-testid*="login" i], [data-testid*="auth" i], .login-form, .signin-form, main, body'
      ) as HTMLFormElement
    }
    const root = form || document.body
    const passwords = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(
      (p) => !isOtpInput(p) && !isCreditCardInput(p)
    )
    const passwordInput = target.type === 'password' ? target : passwords[0] || null

    const usernames = Array.from(
      root.querySelectorAll<HTMLInputElement>(
        'input[autocomplete="username"], input[autocomplete="email"], input[type="email"], input[name*="user" i], input[name*="login" i], input[name*="email" i], input[id*="user" i], input[id*="login" i], input[id*="email" i], input[type="text"]:not([type="password"])'
      )
    ).filter((u) => !isOtpInput(u) && !isCreditCardInput(u) && u.type !== 'hidden')

    const usernameInput = target !== passwordInput && (target.type === 'text' || target.type === 'email')
      ? target
      : usernames[0] || null

    return { usernameInput, passwordInput }
  }

  let currentDropdown: HTMLElement | null = null

  function removeDropdown(): void {
    if (currentDropdown) {
      currentDropdown.remove()
      currentDropdown = null
    }
  }

  async function showSuggestionsFor(input: HTMLInputElement): Promise<void> {
    if (isOtpInput(input) || isCreditCardInput(input)) return

    const { usernameInput, passwordInput } = findAssociatedInputs(input)
    if (!passwordInput) return

    let matches: Array<{ id: string; username: string; accountName: string }> = []
    try {
      matches = (await ipcRenderer.invoke('hub:passwords-query-matches', {
        origin: window.location.origin
      })) as Array<{ id: string; username: string; accountName: string }>
    } catch {
      matches = []
    }

    if (!matches || matches.length === 0) {
      removeDropdown()
      return
    }

    removeDropdown()

    const rect = input.getBoundingClientRect()
    const dropdown = document.createElement('div')
    dropdown.id = '__socialhub_pw_dropdown__'
    dropdown.setAttribute('role', 'listbox')
    dropdown.setAttribute('aria-label', 'Saved credentials suggestion')

    Object.assign(dropdown.style, {
      position: 'fixed',
      top: `${rect.bottom + 4}px`,
      left: `${rect.left}px`,
      minWidth: `${Math.max(220, rect.width)}px`,
      maxWidth: '360px',
      background: '#ffffff',
      color: '#1e2922',
      border: '1px solid #d0d7d2',
      borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
      zIndex: '2147483647',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '13px',
      lineHeight: '1.4',
      overflow: 'hidden',
      userSelect: 'none',
      boxSizing: 'border-box'
    })

    const header = document.createElement('div')
    Object.assign(header.style, {
      padding: '7px 12px 5px',
      fontSize: '10.5px',
      fontWeight: '600',
      color: '#65746b',
      letterSpacing: '0.4px',
      textTransform: 'uppercase',
      borderBottom: '1px solid #edf0ed',
      display: 'flex',
      alignItems: 'center',
      gap: '5px'
    })
    header.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#138b54" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-1.5 1.5L10 13l-4 4-2-2 4-4 7.5-7.5M15 5l2 2"/></svg> Saved Passwords`
    dropdown.appendChild(header)

    for (const match of matches) {
      const item = document.createElement('div')
      Object.assign(item.style, {
        padding: '9px 12px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        borderBottom: '1px solid #f6f8f6',
        transition: 'background 0.15s ease'
      })
      item.innerHTML = `
        <div style="font-weight: 600; color: #16201a; display: flex; align-items: center; gap: 6px;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#68776f" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span>${escapeHtml(match.username || 'Saved Login')}</span>
        </div>
        <div style="font-size: 11px; color: #6d7b73; padding-left: 19px;">${escapeHtml(match.accountName)}</div>
      `

      item.addEventListener('mouseenter', () => {
        item.style.background = '#eef6f1'
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent'
      })

      item.addEventListener('mousedown', async (e) => {
        e.preventDefault()
        try {
          const cred = (await ipcRenderer.invoke('hub:passwords-get-fill', { id: match.id })) as {
            username: string
            password: string
          }
          if (usernameInput && cred.username) {
            usernameInput.value = cred.username
            usernameInput.dispatchEvent(new Event('input', { bubbles: true }))
            usernameInput.dispatchEvent(new Event('change', { bubbles: true }))
          }
          if (passwordInput && cred.password) {
            passwordInput.value = cred.password
            passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
            passwordInput.dispatchEvent(new Event('change', { bubbles: true }))
          }
        } catch (error) {
          console.error('[PASSWORDS][FILL] Error filling credential:', error)
        } finally {
          removeDropdown()
        }
      })

      dropdown.appendChild(item)
    }

    document.body.appendChild(dropdown)
    currentDropdown = dropdown
  }

  // Auto-detect focus on login input fields to display suggestions
  document.addEventListener(
    'focusin',
    (e) => {
      const target = e.target
      if (target instanceof HTMLInputElement && (target.type === 'password' || target.type === 'text' || target.type === 'email')) {
        void showSuggestionsFor(target)
      }
    },
    true
  )

  // Dismiss suggestions on outside click, escape, or scroll
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (currentDropdown && !currentDropdown.contains(e.target as Node)) {
        removeDropdown()
      }
    },
    true
  )

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      removeDropdown()
    }
  })

  window.addEventListener('scroll', removeDropdown, { passive: true })

  // Auto-save on form submit or submit button click
  let lastSavedSignature = ''
  let lastSavedTime = 0

  function captureAndSave(sourceEl: HTMLElement): void {
    const form = sourceEl.closest('form')
    const root = form || document.body
    const passwords = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(
      (p) => !isOtpInput(p) && !isCreditCardInput(p)
    )
    if (passwords.length === 0) return

    const passwordInput = passwords.find((p) => p.value && p.value.trim().length > 0)
    if (!passwordInput || !passwordInput.value) return

    const { usernameInput } = findAssociatedInputs(passwordInput)
    const username = usernameInput ? usernameInput.value.trim() : ''
    const password = passwordInput.value

    const sig = `${window.location.origin}:${username}:${password}`
    const now = Date.now()
    if (sig === lastSavedSignature && now - lastSavedTime < 3000) {
      return
    }
    lastSavedSignature = sig
    lastSavedTime = now

    ipcRenderer.send('hub:passwords-auto-save', {
      origin: window.location.origin,
      username,
      password
    })
  }

  document.addEventListener(
    'submit',
    (e) => {
      if (e.target instanceof HTMLElement) {
        captureAndSave(e.target)
      }
    },
    true
  )

  document.addEventListener(
    'click',
    (e) => {
      const btn = (e.target as HTMLElement)?.closest('button, input[type="submit"]')
      if (btn && btn instanceof HTMLElement) {
        captureAndSave(btn)
      }
    },
    true
  )

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
        captureAndSave(e.target)
      }
    },
    true
  )
}

try {
  initPasswordManagerSupport()
} catch (error) {
  console.error('[PASSWORDS][PRELOAD] Failed to initialize password manager support:', error)
}
