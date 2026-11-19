import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { app, shell } from 'electron'

export interface GoogleOAuthOptions {
  clientId?: string
  clientSecret?: string
}

function getEnvVariable(key: string): string {
  const fromProcess = process.env[key]
  if (typeof fromProcess === 'string' && fromProcess.trim()) {
    return fromProcess.trim()
  }

  // Look in .env.local and .env
  const candidateDirs: string[] = []
  try {
    const cwd = process.cwd()
    if (cwd) candidateDirs.push(cwd)
  } catch {}
  try {
    if (typeof app?.getAppPath === 'function') {
      const appPath = app.getAppPath()
      if (appPath && !candidateDirs.includes(appPath)) candidateDirs.push(appPath)
    }
  } catch {}

  const files = ['.env.local', '.env']
  for (const dir of candidateDirs) {
    for (const file of files) {
      try {
        const fullPath = join(dir, file)
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, 'utf8')
          for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const eqIdx = trimmed.indexOf('=')
            if (eqIdx > 0) {
              const k = trimmed.slice(0, eqIdx).trim()
              if (k === key) {
                let v = trimmed.slice(eqIdx + 1).trim()
                if (
                  (v.startsWith('"') && v.endsWith('"')) ||
                  (v.startsWith("'") && v.endsWith("'"))
                ) {
                  v = v.slice(1, -1)
                }
                if (v) return v
              }
            }
          }
        }
      } catch {}
    }
  }
  return ''
}

export function resolveOAuthClientId(options?: string | GoogleOAuthOptions): string {
  const passed = typeof options === 'string' ? options : options?.clientId
  if (passed && passed.trim()) return passed.trim()
  return getEnvVariable('VITE_GOOGLE_OAUTH_CLIENT_ID')
}

export function resolveOAuthClientSecret(options?: string | GoogleOAuthOptions): string {
  const passed = typeof options === 'object' ? options?.clientSecret : undefined
  if (passed && passed.trim()) return passed.trim()
  return (
    getEnvVariable('GOOGLE_OAUTH_CLIENT_SECRET') ||
    getEnvVariable('GOOGLE_CLIENT_SECRET')
  )
}

interface GoogleTokenResponse {
  id_token?: string
  error?: string
  error_description?: string
}

let currentSession: {
  server: Server
  timeout: ReturnType<typeof setTimeout> | undefined
  finish: (error?: Error, idToken?: string) => void
} | null = null

export function cancelGoogleAuth(reason = 'Google sign-in was cancelled.'): boolean {
  if (currentSession) {
    currentSession.finish(new Error(reason))
    currentSession = null
    return true
  }
  return false
}

const completionPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Social HUB – Sign-in Complete</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f8f6; color: #202923; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: white; border: 1px solid #edf0ed; border-radius: 12px; padding: 32px; max-width: 380px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.06); }
    .icon { width: 44px; height: 44px; background: #e9f5ee; color: #138b54; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-size: 22px; }
    h2 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 0; color: #6b7770; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10003;</div>
    <h2>Sign-in Complete</h2>
    <p>You have successfully authenticated with Google. You can now close this browser tab and return to Social HUB.</p>
  </div>
  <script>setTimeout(() => { try { window.close(); } catch {} }, 1500);</script>
</body>
</html>`

function errorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Social HUB – Sign-in Error</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f8f6; color: #202923; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: white; border: 1px solid #fecaca; border-radius: 12px; padding: 32px; max-width: 380px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.06); }
    .icon { width: 44px; height: 44px; background: #fee2e2; color: #dc2626; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-size: 22px; font-weight: bold; }
    h2 { margin: 0 0 8px; font-size: 18px; color: #b91c1c; }
    p { margin: 0; color: #6b7770; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10005;</div>
    <h2>Sign-in Incomplete</h2>
    <p>${message}</p>
  </div>
</body>
</html>`
}

export function buildTokenExchangeBody(
  code: string,
  clientId: string,
  clientSecret: string | undefined,
  verifier: string,
  redirectUri: string
): URLSearchParams {
  const params: Record<string, string> = {
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  }
  if (clientSecret) {
    params.client_secret = clientSecret
  }
  return new URLSearchParams(params)
}

export async function getGoogleIdToken(options?: string | GoogleOAuthOptions): Promise<string> {
  const cleanClientId = resolveOAuthClientId(options)
  if (!cleanClientId) {
    throw new Error('Google sign-in is not configured. Add VITE_GOOGLE_OAUTH_CLIENT_ID to .env.local.')
  }

  const cleanClientSecret = resolveOAuthClientSecret(options)
  if (!cleanClientSecret) {
    throw new Error('Google sign-in is not fully configured. Add GOOGLE_OAUTH_CLIENT_SECRET to .env.local.')
  }

  // If a session is already in progress, cancel it cleanly before starting a new one
  if (currentSession) {
    cancelGoogleAuth('A new Google sign-in attempt was initiated.')
  }

  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const server = createServer()

  return new Promise<string>((resolve, reject) => {
    let callbackHandled = false
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let redirectUri = ''

    const finish = (error?: Error, idToken?: string) => {
      if (settled) return
      settled = true
      if (currentSession?.server === server) {
        currentSession = null
      }
      if (timeout) clearTimeout(timeout)
      if (server.listening) {
        server.close()
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections()
        }
      }
      if (error) reject(error)
      else if (idToken) resolve(idToken)
      else reject(new Error('Google sign-in did not return an ID token.'))
    }

    currentSession = { server, timeout, finish }

    server.on('request', (request, response) => {
      if (callbackHandled) {
        response.writeHead(409).end()
        return
      }

      const callbackUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method !== 'GET' || callbackUrl.pathname !== '/oauth2callback') {
        response.writeHead(404).end()
        return
      }
      callbackHandled = true

      const receivedState = callbackUrl.searchParams.get('state') ?? ''
      const expectedState = Buffer.from(state)
      const actualState = Buffer.from(receivedState)
      if (
        expectedState.length !== actualState.length ||
        !timingSafeEqual(expectedState, actualState)
      ) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(errorPage('Invalid sign-in state. Please return to Social HUB and try again.'))
        finish(new Error('Google sign-in returned an invalid state.'))
        return
      }

      const providerError = callbackUrl.searchParams.get('error')
      if (providerError) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(errorPage('Google sign-in was not completed. You can close this tab and return to Social HUB.'))
        finish(new Error(`Google sign-in was not completed: ${providerError}.`))
        return
      }

      const code = callbackUrl.searchParams.get('code')
      if (!code || code.length > 4096) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(errorPage('Google sign-in did not return an authorization code.'))
        finish(new Error('Google sign-in did not return an authorization code.'))
        return
      }

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(completionPage)
      void exchangeCode(code, cleanClientId, cleanClientSecret, verifier, redirectUri).then(
        (idToken) => finish(undefined, idToken),
        (error: unknown) => finish(error instanceof Error ? error : new Error('Google token exchange failed.'))
      )
    })

    server.on('error', (error) => finish(error))

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        finish(new Error('Could not start the local Google sign-in callback server.'))
        return
      }

      redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      authUrl.search = new URLSearchParams({
        client_id: cleanClientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      }).toString()

      timeout = setTimeout(() => finish(new Error('Google sign-in timed out. Please try again.')), 5 * 60 * 1000)
      if (timeout && typeof timeout.unref === 'function') {
        timeout.unref()
      }
      if (currentSession) {
        currentSession.timeout = timeout
      }

      void shell.openExternal(authUrl.toString()).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error('Could not open the system browser.'))
      })
    })
  })
}

async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string | undefined,
  verifier: string,
  redirectUri: string
): Promise<string> {
  const body = buildTokenExchangeBody(code, clientId, clientSecret, verifier, redirectUri)
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000)
  })
  const result = (await response.json()) as GoogleTokenResponse
  if (!response.ok) {
    const description = result.error_description ?? result.error ?? 'Unknown token exchange error'
    throw new Error(`Google sign-in failed: ${description}.`)
  }
  if (typeof result.id_token !== 'string' || !result.id_token) {
    throw new Error('Google did not return an ID token.')
  }
  return result.id_token
}
