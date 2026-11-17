import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { shell } from 'electron'

interface GoogleTokenResponse {
  id_token?: string
  error?: string
  error_description?: string
}

const completionPage = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Social Hub sign-in</title>
<body style="font:16px system-ui;padding:32px;color:#243128">
<h2>Sign-in complete</h2><p>You can close this browser tab and return to Social Hub.</p>
</body></html>`

export async function getGoogleIdToken(clientId: string): Promise<string> {
  if (!clientId) throw new Error('Google sign-in is not configured. Add VITE_GOOGLE_OAUTH_CLIENT_ID to .env.local.')

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
      if (timeout) clearTimeout(timeout)
      if (server.listening) server.close()
      if (error) reject(error)
      else if (idToken) resolve(idToken)
      else reject(new Error('Google sign-in did not return an ID token.'))
    }

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
        response.writeHead(400).end('Invalid sign-in state. Return to Social Hub and try again.')
        finish(new Error('Google sign-in returned an invalid state.'))
        return
      }

      const providerError = callbackUrl.searchParams.get('error')
      if (providerError) {
        response.writeHead(400).end('Google sign-in was not completed. Return to Social Hub.')
        finish(new Error(`Google sign-in was not completed: ${providerError}.`))
        return
      }

      const code = callbackUrl.searchParams.get('code')
      if (!code || code.length > 4096) {
        response.writeHead(400).end('Google sign-in did not return an authorization code.')
        finish(new Error('Google sign-in did not return an authorization code.'))
        return
      }

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(completionPage)
      void exchangeCode(code, clientId, verifier, redirectUri).then(
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
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      }).toString()

      timeout = setTimeout(() => finish(new Error('Google sign-in timed out. Please try again.')), 5 * 60 * 1000)
      void shell.openExternal(authUrl.toString()).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error('Could not open the system browser.'))
      })
    })
  })
}

async function exchangeCode(
  code: string,
  clientId: string,
  verifier: string,
  redirectUri: string
): Promise<string> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    }),
    signal: AbortSignal.timeout(15_000)
  })
  const result = await response.json() as GoogleTokenResponse
  if (!response.ok) {
    const description = result.error_description ?? result.error ?? 'Unknown token exchange error'
    throw new Error(`Google sign-in failed: ${description}.`)
  }
  if (typeof result.id_token !== 'string' || !result.id_token) {
    throw new Error('Google did not return an ID token.')
  }
  return result.id_token
}
